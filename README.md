# ClinicOS — Multi-Tenant Clinic Scheduling Engine

Node.js (ES modules) API that computes appointment slots on demand, books them with MongoDB-backed concurrency control, and supports waitlist offers when slots open.

## Prerequisites

- Node.js 20+
- MongoDB 7+ as a **replica set** (transactions require it)
- Docker (optional, for local Mongo)

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Start local Mongo (replica set)
docker compose up -d
# Wait until healthy, then init replica set if first run:
# docker compose exec mongo mongosh --eval 'rs.initiate({_id:"rs0", members:[{_id:0, host:"localhost:27017"}]})'

# 3. Environment
cp .env.example .env
# Default local URI:
# MONGODB_URI=mongodb://localhost:27017/clinic_scheduling?replicaSet=rs0

# 4. Sync indexes and seed demo data
npm run setup:indexes
npm run seed

# 5. Run API
npm run dev
```

Health check: `GET http://localhost:3000/health`

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start API with watch mode |
| `npm start` | Start API |
| `npm test` | Run Vitest suite (uses `MONGODB_URI` from `.env`) |
| `npm run seed` | Reset DB and load demo clinics, doctors, appointments, waitlist |
| `npm run setup:indexes` | Sync Mongoose indexes to MongoDB |

## Architecture

```
Client → Express routes → Controllers → Services → Mongoose models → MongoDB
```

**Slot generation is pure and on-demand.** There is no `slots` collection. Available times are computed from:

1. Weekly `availabilityTemplates`
2. Per-date `availabilityExceptions` (block or override)
3. Active `slotReservations` (confirmed or non-expired holds)

**Booking** creates a `slotReservations` document (held, then confirmed) and an `appointments` document. A partial unique index on `{ clinicId, doctorId, slotStart }` for active reservations prevents double-booking the same instant.

**Audit** uses `appointmentEvents`, written in the same MongoDB transaction as appointment/reservation changes.

**Waitlist** uses `waitlistEntries` plus `slotOffers`. Cancelling a confirmed appointment can create exactly one active offer per opened slot (enforced by a partial unique index on offers).

## Data model (collections)

| Collection | Role |
|------------|------|
| `clinics` | Tenant root; timezone drives local slot boundaries |
| `doctors` | Per-clinic providers and supported appointment types |
| `appointmenttypes` | Duration and metadata for bookable types |
| `availabilitytemplates` | Weekly recurring windows per doctor |
| `availabilityexceptions` | Date-specific block or override windows |
| `slotreservations` | Concurrency lock + hold/confirm lifecycle |
| `appointments` | Patient booking state machine |
| `appointmentevents` | Immutable audit trail |
| `waitlistentries` | Queue when a day/type is fully booked |
| `slotoffers` | Time-limited offers after a cancellation |

There is **no** pre-materialised slots collection.

## Authentication

**Production** (`NODE_ENV=production`): send a signed JWT on every protected route:

```http
Authorization: Bearer <token>
```

JWT payload fields:

| Claim | Description |
|-------|-------------|
| `sub` | Actor ID (patient or staff user) |
| `clinicId` | Tenant clinic ID |
| `role` | `patient`, `clinic_staff`, or `system` |
| `name` | Display name (optional) |

Sign tokens with `JWT_SECRET` and `JWT_EXPIRES_IN` from `.env`. Tests use `signToken()` from `src/utils/jwt.js`.

**Development / test** (`NODE_ENV` not `production`): dev headers are also accepted when no Bearer token is present:

```http
x-clinic-id: clinic_india
x-actor-id: patient_demo
x-actor-role: patient
x-actor-name: Demo Patient
```

## Multi-tenancy

Every tenant-owned document includes `clinicId`. API handlers resolve the clinic from the verified auth context and scope queries with it.

Cross-clinic access (e.g. clinic A token reading clinic B data) returns `403`.

**Waitlist ownership:** only the patient on a waitlist entry can accept an offer; patients cannot remove or accept another patient's entry (`403`). Clinic staff may remove entries on behalf of operations.

## Concurrency

Double-booking is prevented by:

1. **Overlap check** in application code before insert
2. **Partial unique index** on `slotReservations` for active rows sharing the same `clinicId`, `doctorId`, and `slotStart`

Concurrent `POST /appointments` for the same slot: exactly one succeeds; others receive `409`.

The test suite includes a 20-way parallel booking test (`tests/booking.concurrency.test.js`).

## NoSQL tradeoffs

| Choice | Benefit | Cost |
|--------|---------|------|
| Compute slots at read time | No stale slot grid; exceptions apply immediately | CPU per `/slots` query; 30-day max query window |
| Separate reservations collection | Atomic uniqueness without overloading appointments | Extra collection and sync on reschedule |
| Embedded weekly template + separate exceptions | Simple recurring schedule + flexible overrides | Must merge both when validating or generating |
| Event collection | Full audit without bloating appointment documents | More writes per transition |
| Replica set + transactions | Safe book/confirm/cancel/waitlist accept | Operational requirement for Mongo |

## API overview

See `docs/ApiContracts.md` for full request/response shapes. Main groups:

- Clinics, doctors, appointment types
- Availability templates and exceptions
- `GET /slots` — generated availability
- Appointments — book, confirm, cancel, reschedule, no-show, complete, list, history
- Waitlist — join, accept offer, list, remove

## Double-booking demo

With the API running and seed data loaded:

```bash
# Pick a slot from the seeded doctor (adjust IDs/dates from seed output or GET /slots)
CLINIC=clinic_india
DOCTOR=$(curl -s "http://localhost:3000/clinics/$CLINIC/doctors" -H "x-clinic-id: $CLINIC" -H "x-actor-id: staff" -H "x-actor-role: clinic_staff" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d)[0]._id))")

FROM=$(date -v+3d +%F 2>/dev/null || date -d '+3 days' +%F)
TO=$(date -v+10d +%F 2>/dev/null || date -d '+10 days' +%F)
TYPE=$(curl -s "http://localhost:3000/clinics/$CLINIC/appointment-types" -H "x-clinic-id: $CLINIC" -H "x-actor-id: staff" -H "x-actor-role: clinic_staff" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).find(t=>t.name==='General Consult')._id))")

SLOT=$(curl -s "http://localhost:3000/slots?doctorId=$DOCTOR&appointmentType=$TYPE&from=$FROM&to=$TO" \
  -H "x-clinic-id: $CLINIC" -H "x-actor-id: staff" -H "x-actor-role: clinic_staff" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).slots[0].start))")

# Fire two bookings in parallel for the same slotStart
for i in 1 2; do
  curl -s -o /tmp/book-$i.json -w "%{http_code}\n" -X POST http://localhost:3000/appointments \
    -H "Content-Type: application/json" \
    -H "x-clinic-id: $CLINIC" -H "x-actor-id: patient_$i" -H "x-actor-role: patient" \
    -d "{\"doctorId\":\"$DOCTOR\",\"appointmentTypeId\":\"$TYPE\",\"slotStart\":\"$SLOT\",\"patientId\":\"race_$i\"}" &
done
wait
```

Expect one `201` and one `409`. Or run `npm test` and inspect `tests/booking.concurrency.test.js` (20 parallel requests).

## Manual demo checklist

1. `docker compose up -d` → `npm run setup:indexes` → `npm run seed`
2. `GET /health`
3. `GET /slots` for a seeded doctor
4. `POST /appointments` → `PATCH .../confirm`
5. `GET /appointments/:id/history`
6. Parallel bookings on same slot (one winner)
7. `DELETE /appointments/:id` (releases reservation; may trigger waitlist offer)
8. `PATCH /appointments/:id` reschedule (same appointment `_id`)
9. Cross-clinic request with wrong `x-clinic-id` → `403`

## Testing

```bash
npm test          # integration suite (excludes destructive seed smoke test)
npm run test:seed # clears DB and runs seed; verifies counts and /slots
npm run test:all  # both
```

Integration tests use `MONGODB_URI` from `.env` (Atlas or local). Vitest runs with a single worker to avoid cross-test interference.

## Documentation

| Doc | Contents |
|-----|----------|
| `docs/Task.md` | Product specification |
| `docs/CursorPlan.md` | Implementation checkpoints |
| `docs/Progress.md` | Session resume tracker |
| `docs/DataModel.md` | Schema and indexes |
| `docs/ApiContracts.md` | HTTP contracts |
| `docs/TestingPlan.md` | Test matrix |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `MONGODB_URI` | — | Mongo connection string (replica set required) |
| `PENDING_HOLD_MINUTES` | `5` | Pending booking TTL |
| `WAITLIST_OFFER_MINUTES` | `15` | Waitlist offer TTL |
| `MAX_SLOT_QUERY_DAYS` | `30` | Max `/slots` date range |
