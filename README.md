# ClinicOS — Multi-Tenant Clinic Scheduling Engine

NoSQL-first scheduling core for small clinics. **Slots are computed at query time** from weekly availability templates, date exceptions, and active reservations. There is **no pre-materialised `slots` collection**.

Built with Node.js, Express, MongoDB (replica set for transactions), and Luxon for clinic-local time boundaries.

---

## Table of contents

1. [Quick start](#quick-start)
2. [System context](#system-context)
3. [Layered architecture](#layered-architecture)
4. [Request pipeline](#request-pipeline)
5. [Data model](#data-model)
6. [Slot derivation engine](#slot-derivation-engine)
7. [Booking and concurrency](#booking-and-concurrency)
8. [Hold lifecycle (5-minute TTL)](#hold-lifecycle-5-minute-ttl)
9. [State machines](#state-machines)
10. [Waitlist engine](#waitlist-engine)
11. [Availability dry-run](#availability-dry-run)
12. [Multi-tenancy](#multi-tenancy)
13. [Design memos (Part 2)](#design-memos-part-2)
14. [Error and HTTP matrix](#error-and-http-matrix)
15. [Indexes](#indexes)
16. [API overview](#api-overview)
17. [Testing](#testing)
18. [Environment variables](#environment-variables)
19. [File map](#file-map)

---

## Quick start

### Prerequisites

- Node.js 20+
- Docker (for local MongoDB replica set — required for multi-document transactions)

### Setup

```bash
npm install
cp .env.example .env
docker compose up -d
# First run only — init replica set if needed:
# docker compose exec mongo mongosh --eval 'rs.initiate({_id:"rs0", members:[{_id:0, host:"localhost:27017"}]})'
npm run setup:indexes
npm run seed
npm run dev
```

| Resource | URL |
|----------|-----|
| API | http://localhost:3000 |
| Health | http://localhost:3000/health |
| Swagger UI | http://localhost:3000/api-docs |
| OpenAPI spec | `openapi/openapi.yaml` |

### Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start API with watch |
| `npm test` | Integration test suite |
| `npm run seed` | Seed demo clinics, doctors, types |
| `npm run setup:indexes` | Sync Mongoose indexes |
| `npm run e2e:curl` | Route smoke tests (server must be running) |

---

## System context

```mermaid
C4Context
  title ClinicOS — System Context

  Person(patient, "Patient", "Books slots, confirms, joins waitlist")
  Person(staff, "Clinic staff", "Availability, outcomes, waitlist")
  System(clinicos, "ClinicOS API", "Scheduling, booking, audit")
  SystemDb(mongo, "MongoDB Replica Set", "Documents + transactions")

  Rel(patient, clinicos, "HTTPS / JSON + JWT")
  Rel(staff, clinicos, "HTTPS / JSON + JWT")
  Rel(clinicos, mongo, "Mongoose, withTransaction")
```

**Deliberate constraints:**

- No `slots` collection — slots are derived, not stored
- No per-second cron for hold expiry — lazy/event-driven cleanup via `holdLifecycle.service.js`
- Tenant isolation via `clinicId` on every document and JWT middleware

---

## Layered architecture

```mermaid
flowchart TB
  subgraph L1["Presentation"]
    R["routes/index.js"]
    C["controllers/*.js"]
    V["validators/*.js — Zod"]
  end

  subgraph L2["Middleware"]
    A["auth.js — JWT → req.actor"]
    T["tenant.js — req.clinicId"]
    E["error.js — AppError → JSON"]
  end

  subgraph L3["Domain services"]
    SE["slot.engine.js — pure slot math"]
    SS["slot.service.js — getSlots, overlap"]
    BS["booking.service.js — lifecycle"]
    HL["holdLifecycle.service.js — lazy expiry"]
    ES["event.service.js — audit"]
    AV["availability.service.js"]
    WL["waitlist.service.js"]
  end

  subgraph L4["MongoDB collections"]
    TPL[(availabilityTemplates)]
    EXC[(availabilityExceptions)]
    RES[(slotReservations)]
    APPT[(appointments)]
    EVTS[(appointmentEvents)]
    WLQ[(waitlist / offers)]
  end

  R --> A --> T --> V --> C
  C --> L3 --> L4
```

| Layer | Responsibility | Concurrency |
|-------|----------------|-------------|
| Controllers | HTTP in/out | No |
| `slot.service` | Load data, call engine, overlap **reads** | Pre-check only |
| `booking.service` | Writes + transactions | **Yes** — txn + unique index + CAS |
| `holdLifecycle` | Expire stale holds | Idempotent updates |
| `slot.engine` | Pure computation | No I/O |

---

## Request pipeline

Every protected route follows this path:

```mermaid
sequenceDiagram
  participant Client
  participant Auth as auth.js
  participant Tenant as tenant.js
  participant Zod as validate.js
  participant Ctrl as controller
  participant Svc as service
  participant DB as MongoDB

  Client->>Auth: Bearer JWT
  Auth->>Tenant: req.actor.clinicId
  Note over Tenant: Route /clinics/:id must match token
  Tenant->>Zod: Parse body/query/params
  Zod->>Ctrl: req.validated
  Ctrl->>Svc: Always pass clinicId
  Svc->>DB: Query or withTransaction
  DB-->>Client: JSON response
```

**Public routes (no JWT):** `GET /health`, `POST /clinics`, `POST /auth/signup`, `POST /auth/login`

---

## Data model

### Entity relationship

```mermaid
erDiagram
  Clinic ||--o{ Doctor : has
  Clinic ||--o{ AppointmentType : has
  Doctor ||--|| AvailabilityTemplate : has
  Doctor ||--o{ AvailabilityException : has
  Doctor ||--o{ Appointment : has
  Appointment ||--|| SlotReservation : currentReservationId
  Appointment ||--o{ AppointmentEvent : audit
  Doctor ||--o{ WaitlistEntry : has
  WaitlistEntry ||--o| SlotOffer : offer
```

### Two parallel truths

| Concept | Collection | Mutable? | Purpose |
|---------|------------|----------|---------|
| **Lock** | `slotReservations` | Yes | Prevents double-booking |
| **Booking** | `appointments` | Yes | API read model (`version` for CAS) |
| **Audit** | `appointmentEvents` | **Append-only** | Compliance trail |

### Example documents

**AvailabilityTemplate**

```json
{
  "_id": "tpl_abc",
  "clinicId": "clinic_1",
  "doctorId": "dr_1",
  "weeklyTemplate": {
    "MON": [{ "start": "09:00", "end": "13:00" }, { "start": "15:00", "end": "18:00" }],
    "TUE": [{ "start": "10:00", "end": "17:00" }]
  },
  "isActive": true,
  "version": 1
}
```

**AvailabilityException**

```json
{
  "clinicId": "clinic_1",
  "doctorId": "dr_1",
  "date": "2025-06-10",
  "type": "block"
}
```

Types: `block` (no slots), `override` (replace template for that date), `additional` (extra windows on top of template).

**SlotReservation** (the lock — not a pre-built slot)

```json
{
  "_id": "res_xyz",
  "clinicId": "clinic_1",
  "doctorId": "dr_1",
  "appointmentId": "appt_01",
  "slotStart": "2025-06-10T03:30:00.000Z",
  "slotEnd": "2025-06-10T03:45:00.000Z",
  "status": "held",
  "holdExpiresAt": "2025-06-10T03:35:00.000Z"
}
```

**Appointment**

```json
{
  "_id": "appt_01",
  "clinicId": "clinic_1",
  "doctorId": "dr_1",
  "status": "pending",
  "version": 2,
  "currentReservationId": "res_xyz",
  "currentSlotStart": "2025-06-10T03:30:00.000Z",
  "durationMinutes": 15,
  "patient": { "name": "Jane", "phone": "+91..." }
}
```

**AppointmentEvent** (immutable)

```json
{
  "appointmentId": "appt_01",
  "clinicId": "clinic_1",
  "eventType": "created",
  "previousState": null,
  "newState": "pending",
  "actor": { "id": "patient_1", "role": "patient" },
  "timestamp": "2025-06-10T03:30:00.000Z"
}
```

### Embed vs reference

| Data | Choice | Why |
|------|--------|-----|
| `patient` on appointment | Embed | Snapshot at booking; no separate patient service |
| `appointmentTypeName`, `durationMinutes` | Embed | Historical accuracy if type changes |
| `slotReservation` | Separate collection | Lock lifecycle + unique index per slot |
| `appointmentEvents` | Separate collection | Append-only audit; never update/delete |

---

## Slot derivation engine

### GET /slots flow

```mermaid
sequenceDiagram
  participant C as Client
  participant SS as slot.service
  participant HL as holdLifecycle
  participant SE as slot.engine
  participant DB as MongoDB

  C->>SS: GET /slots?doctorId&appointmentType&from&to
  SS->>DB: clinic timezone, template, exceptions, type
  SS->>HL: expireStaleHoldsInRange (max 50)
  HL->>DB: held + expired → status expired + event
  SS->>DB: active reservations in range
  SS->>SE: computeAvailableSlots(...)
  Note over SE: template + exceptions − overlaps
  SE-->>C: { slots: [{ start, end, startLocal }] }
```

### Exception precedence (per local date)

| Priority | `type` | Effective windows |
|----------|--------|-------------------|
| 1 | `block` | None |
| 2 | `override` | Exception windows only |
| 3 | `additional` | Template + exception windows |
| 4 | (none) | Template for weekday |

Implemented in `src/services/slot.engine.js` → `effectiveWindowsForDate()`.

### Algorithm

```mermaid
flowchart TD
  A[GET /slots] --> B[Validate range ≤ MAX_SLOT_QUERY_DAYS]
  B --> C[Load template + exceptions]
  C --> D[Sweep stale holds in range]
  D --> E[Load active reservations]
  E --> F{For each local date}
  F --> G[Merge template + exception]
  G --> H{For each time window}
  H --> I[Step cursor by durationMinutes]
  I --> J{Overlaps active reservation?}
  J -->|No| K{cursor >= now?}
  K -->|Yes| L[Include slot]
  J -->|Yes| M[Skip]
```

**Active reservation** (`slot.service.js`):

```
status = confirmed
OR (status = held AND holdExpiresAt > now)
```

**Overlap** (interval intersection — supports mixed durations):

```
reservation.slotStart < candidateEnd AND reservation.slotEnd > candidateStart
```

**Performance:** Conflict check is `reservations.some()` per candidate slot — O(slots × reservations). Correct for moderate load; busy 30-day doctors may benefit from sorted-interval optimisation.

---

## Booking and concurrency

### POST /appointments — step trace

| Step | Location | Action |
|------|----------|--------|
| 1 | `booking.service` | Idempotency: `clinicId + idempotencyKey` → 200 if exists |
| 2 | | Validate future slot, doctor supports type |
| 3 | `slot.service` | `assertNoActiveReservationOverlap` |
| 4 | | `assertGeneratedSlot` (slot must exist on grid) |
| 5 | Transaction | `INSERT slotReservation` — `held`, `holdExpiresAt = now + 5m` |
| 6 | | `INSERT appointment` — `pending` |
| 7 | | `INSERT appointmentEvent` — `created` |
| 8 | On `E11000` | `expireHoldBySlot` → retry once OR **409** |

### Race: two patients, same slot

```mermaid
sequenceDiagram
  participant P1 as Patient 1
  participant P2 as Patient 2
  participant API as booking.service
  participant DB as MongoDB

  par Parallel POST same slotStart
    P1->>API: POST /appointments
    P2->>API: POST /appointments
  end

  API->>DB: Txn1 INSERT reservation → OK
  API->>DB: Txn2 INSERT reservation → E11000
  API-->>P1: 201 pending
  API-->>P2: 409 slot taken
```

**Partial unique index** on `slotReservations`:

```javascript
{ clinicId: 1, doctorId: 1, slotStart: 1 }
// unique WHERE status IN ['held', 'confirmed']
```

### PATCH /confirm

| Step | Action |
|------|--------|
| Pre | Reservation `held` AND `holdExpiresAt > now` |
| Fail | `expirePendingHold` → **410 Gone** |
| Txn | CAS appointment `{ pending, version: N }` → confirmed |
| Txn | Reservation `held` → `confirmed`, unset `holdExpiresAt` |
| Txn | Event `confirmed` |

### PATCH /appointments/:id (reschedule) — CAS

| Step | Inside transaction |
|------|-------------------|
| 1 | Read appointment |
| 2 | **Claim:** `findOneAndUpdate { version: N }` → `$inc version` |
| 3 | Create new reservation at new slot |
| 4 | Update appointment slot fields |
| 5 | Release old reservation → `released` |
| 6 | Event `rescheduled` |

Concurrent reschedule loser: **409** `Appointment was already updated`.

### Double-booking demo

```bash
# After seed — pick slotStart from GET /slots
export TOKEN="..." # from POST /auth/login
export SLOT="2025-06-15T09:00:00.000Z"

for i in 1 2; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/appointments \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"doctorId\":\"...\",\"appointmentTypeId\":\"...\",\"slotStart\":\"$SLOT\",\"patientId\":\"p$i\",\"idempotencyKey\":\"demo-$i\"}" &
done
wait
# Expect: one 201, one 409
```

Or run: `tests/booking.concurrency.test.js` (20 parallel requests).

---

## Hold lifecycle (5-minute TTL)

Pending bookings hold a slot for **5 minutes** (`PENDING_HOLD_MINUTES`) while the patient completes checkout. After TTL, the slot must be bookable again **without a cron job**.

```mermaid
flowchart LR
  subgraph Triggers
    T1[POST /appointments E11000 retry]
    T2[PATCH /confirm after TTL]
    T3[GET /slots sweep max 50]
  end

  subgraph holdLifecycle.service
    A1[reservation held → expired]
    A2[appointment pending → expired]
    A3[event expired]
  end

  T1 & T2 & T3 --> A1 --> A2 --> A3
```

| Trigger | Function |
|---------|----------|
| Rebook hits duplicate key on stale hold | `expireHoldBySlot` |
| Confirm after TTL | `expirePendingHold` then 410 |
| Browse slots | `expireStaleHoldsInRange` |

`/slots` already **ignores** expired holds in queries; hold lifecycle **aligns DB state** with that behaviour.

---

## State machines

### SlotReservation

```mermaid
stateDiagram-v2
  [*] --> held: POST /appointments
  held --> confirmed: PATCH /confirm
  held --> expired: holdLifecycle
  held --> released: cancel / reschedule
  confirmed --> released: cancel / reschedule
```

### Appointment

```mermaid
stateDiagram-v2
  [*] --> pending: POST /appointments
  pending --> confirmed: confirm
  pending --> expired: holdLifecycle
  pending --> cancelled: DELETE
  confirmed --> cancelled: DELETE
  confirmed --> no_show: staff PATCH
  confirmed --> completed: staff PATCH
```

---

## Waitlist engine

```mermaid
flowchart TD
  A[Day fully booked] --> B[POST /waitlist]
  B --> C{GET /slots has openings?}
  C -->|Yes| D[400 book directly]
  C -->|No| E[WaitlistEntry waiting]

  F[Cancel appointment] --> G[offerNextWaitlistPatient]
  G --> H[Sort urgencyFlag DESC joinedAt ASC]
  H --> I[SlotOffer offered TTL 15min]
  I --> J[Unique: one offered per slot]

  J --> K{POST /waitlist/:id/accept}
  K -->|OK| L[createConfirmedAppointment]
  K -->|Expired| M[Next in queue]
  K -->|Taken| N[Supersede offer]
```

---

## Availability dry-run

`POST /doctors/:id/availability/validate`

- Input: proposed `weeklyTemplate` + date range (max 90 days)
- Loads **confirmed** appointments in range
- Returns appointments that would fall outside new windows
- **Does not persist** the template change

Response shape: `{ conflictCount, conflicts: [{ appointmentId, slotStart, patientName, appointmentType }] }`

---

## Multi-tenancy

**Strategy:** Shared database, shared collections, **`clinicId` on every tenant document**.

```mermaid
flowchart LR
  JWT["JWT: clinicId, role, id"] --> MW["tenant.js"]
  MW -->|mismatch| E403[403 Forbidden]
  MW -->|ok| SVC["All queries filter clinicId"]
  SVC -->|wrong tenant| E404[404 Not Found]
```

**Unsafe:**

```javascript
Appointment.findById(appointmentId);
```

**Safe:**

```javascript
Appointment.findOne({ _id: appointmentId, clinicId: req.clinicId });
```

Cross-clinic access returns **404** (not 403) to avoid leaking resource existence.

**Scaling to ~500 clinics:** Indexes must lead with `clinicId`. All tenants share collections; isolation is application-enforced. At very large scale, consider database-per-tenant for enterprise customers.

Tests: `tests/multi-tenancy.test.js`, `tests/auth.test.js`

---

## Design memos (Part 2)

### 2.1 Data model — why this shape?

- **Templates + exceptions** capture recurring and one-off schedule changes without regenerating slot rows.
- **`slotReservations`** are locks with a lifecycle, not calendar slots.
- **`appointments`** are the mutable read model patients and staff interact with.
- **`appointmentEvents`** provide an immutable audit trail required for compliance.

**If starting over:** Pre-parse reservation intervals and use a single-pass interval scan in `slot.engine.js` for better 30-day query performance on busy doctors.

### 2.2 Concurrency strategy (350–450 words)

Double-booking is prevented by **three cooperating layers**:

1. **Application overlap check** — `assertNoActiveReservationOverlap` rejects any candidate interval that intersects an active reservation before write.

2. **MongoDB multi-document transaction** — `withTransaction` ensures appointment, reservation, and event are written atomically or not at all. Requires a replica set.

3. **Partial unique index** — `{ clinicId, doctorId, slotStart }` unique where `status ∈ { held, confirmed }`. Two concurrent inserts for the same slot produce `E11000` on the loser; the API returns **409 Conflict** with message *"This slot has just been taken."*

**Loser behaviour:** HTTP 409 with structured `{ error: { code, message } }`. Clients should refresh `/slots` and pick another time.

**Pending hold expiry without cron:** `holdLifecycle.service.js` expires stale holds lazily when:
- a new booking collides with an expired hold (retry path),
- confirm is attempted after TTL (410 + cleanup),
- `GET /slots` runs a bounded sweep (50 rows per request).

**Reschedule races:** Optimistic locking via `appointment.version` — claim with `findOneAndUpdate` inside a transaction; concurrent updates get 409.

**At 10,000 vs 100 concurrent requests:** The unique index serialises writes per exact `slotStart`. Correctness holds; hot slots see higher latency and 409 retry rates. MongoDB’s atomic document updates help, but there is no SQL-style row lock — we accept retry storms on popular slots as the tradeoff for document-model flexibility.

**Proof:** `tests/booking.concurrency.test.js`, `tests/appointment-transitions.concurrency.test.js`

### 2.3 Multi-tenancy

- **Model:** `clinicId` field on every document; JWT embeds tenant context.
- **Enforcement:** `tenant.js` middleware + mandatory `clinicId` in service queries.
- **Before/after:** See [Multi-tenancy](#multi-tenancy) section above.
- **500 clinics:** Shared collections are fine if indexes are tenant-prefixed; monitor index size and query plans on `clinicId`-leading indexes.

### 2.4 NoSQL tradeoffs (200–250 words)

**1. Interval scheduling without SQL range types**

Relational databases express “no overlapping appointments” with range types and exclusion constraints. MongoDB has no equivalent. We derive slots in Node (`slot.engine.js`) and enforce writes with overlap queries plus a partial unique index on `slotStart`. **Mitigation:** three-layer concurrency. **Accepted:** application-side slot math and retry under contention.

**2. Mutable state + audit trail**

SQL can use triggers or temporal tables. Here, `appointments` mutate while `appointmentEvents` append in the same transaction. **Mitigation:** `withTransaction` + no update/delete paths on events. **Accepted:** no database-enforced FK between event stream and current row — correctness depends on disciplined service code.

---

## Error and HTTP matrix

| HTTP | Code | When |
|------|------|------|
| 200 | — | Success; idempotent booking replay |
| 201 | — | New booking created |
| 400 | `BAD_REQUEST` | Invalid input, wrong state, slot off-grid |
| 401 | `UNAUTHORIZED` | Missing or invalid JWT |
| 403 | `FORBIDDEN` | Clinic mismatch, waitlist ownership |
| 404 | `NOT_FOUND` | Resource not found in tenant |
| 409 | `CONFLICT` | Slot taken, version race, duplicate waitlist |
| 410 | `GONE` | Hold or waitlist offer expired |
| 500 | `INTERNAL_SERVER_ERROR` | Unhandled error |

---

## Indexes

Run `npm run setup:indexes` after schema changes.

| Collection | Index | Serves |
|------------|-------|--------|
| `slotReservations` | `{ clinicId, doctorId, slotStart }` unique partial active | Anti double-book |
| `slotReservations` | `{ clinicId, doctorId, status, slotStart, slotEnd }` | Overlap + `/slots` range |
| `slotReservations` | `{ clinicId, status, holdExpiresAt }` | Stale hold sweep |
| `appointments` | `{ clinicId, idempotencyKey }` unique sparse | Idempotent POST |
| `appointments` | `{ clinicId, doctorId, status, currentSlotStart }` | List by doctor/date |
| `appointmentEvents` | `{ appointmentId, timestamp }` | History |
| `slotOffers` | `{ clinicId, doctorId, appointmentTypeId, slotStart }` unique partial offered | One offer per slot |
| `waitlistEntries` | urgency + joinedAt | Queue ordering |

---

## API overview

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health check |
| POST | `/auth/signup`, `/auth/login` | JWT auth |
| PUT | `/doctors/:id/availability` | Weekly template |
| POST | `/doctors/:id/exceptions` | Date exception |
| POST | `/doctors/:id/availability/validate` | Dry-run schedule change |
| GET | `/slots` | Available slots (derived) |
| POST | `/appointments` | Book (pending hold) |
| PATCH | `/appointments/:id/confirm` | Confirm within TTL |
| PATCH | `/appointments/:id` | Reschedule |
| DELETE | `/appointments/:id` | Cancel |
| PATCH | `/appointments/:id/noshow`, `/complete` | Staff outcomes |
| GET | `/appointments/:id/history` | Audit trail |
| POST | `/waitlist` | Join waitlist |
| POST | `/waitlist/:id/accept` | Accept offer |

Full contract: `openapi/openapi.yaml` · Postman: `postman/ClinicOS.postman_collection.json`

---

## Testing

```bash
npm test
```

| Test file | Proves |
|-----------|--------|
| `tests/booking.concurrency.test.js` | 20 parallel → 1 winner |
| `tests/appointment-transitions.concurrency.test.js` | Confirm/cancel/reschedule races |
| `tests/slots.api.test.js` | Slot derivation, hold sweep |
| `tests/multi-tenancy.test.js` | Tenant isolation |
| `tests/events.test.js` | Audit trail |
| `tests/waitlist.test.js` | Waitlist flow |

With server running: `npm run e2e:curl`

---

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `MONGODB_URI` | local replica set | Mongo connection |
| `JWT_SECRET` | `dev-secret` | Token signing |
| `JWT_EXPIRES_IN` | `7d` | Token TTL |
| `NODE_ENV` | `development` | Environment |
| `MAX_SLOT_QUERY_DAYS` | `30` | Max `/slots` range |
| `PENDING_HOLD_MINUTES` | `5` | Booking hold TTL |
| `WAITLIST_OFFER_MINUTES` | `15` | Waitlist offer TTL |

See `.env.example` for a template.

---

## File map

| File | Role |
|------|------|
| `src/services/slot.engine.js` | Pure slot generation from template + exceptions |
| `src/services/slot.service.js` | `getSlots`, overlap checks, `assertGeneratedSlot` |
| `src/services/booking.service.js` | Book, confirm, cancel, reschedule, outcomes |
| `src/services/holdLifecycle.service.js` | Lazy hold expiry |
| `src/services/event.service.js` | Append-only audit writes |
| `src/services/availability.service.js` | Templates, exceptions, validate |
| `src/services/waitlist.service.js` | Queue, offers, accept |
| `src/utils/transactions.js` | MongoDB session wrapper |
| `src/middleware/tenant.js` | Tenant guard |
| `src/middleware/auth.js` | JWT verification |
| `scripts/seed.js` | Demo data |
| `scripts/setup-indexes.js` | Index sync |

---

## Diagram export

Mermaid diagrams in this README render on GitHub and in VS Code (Mermaid extension). To export as PNG/SVG for slides:

1. Copy a diagram block into https://mermaid.live  
2. Export image  
3. Optional: commit under `docs/diagrams/` and link from here

---

## Licence

Private / assessment project — see repository owner for terms.
