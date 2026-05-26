# Clinic Scheduling Engine — Master Documentation

## Table of Contents
1. [What We Are Building](#1-what-we-are-building)
2. [Tech Stack and Why](#2-tech-stack-and-why)
3. [System Architecture](#3-system-architecture)
4. [Data Model](#4-data-model)
5. [Indexes](#5-indexes)
6. [Slot Engine — How It Works](#6-slot-engine--how-it-works)
7. [Concurrency Strategy](#7-concurrency-strategy)
8. [Multi-Tenancy Model](#8-multi-tenancy-model)
9. [Event Log Design](#9-event-log-design)
10. [What We Gave Up By Not Using SQL](#10-what-we-gave-up-by-not-using-sql)
11. [All Endpoints — Logic, Constraints, Edge Cases](#11-all-endpoints--logic-constraints-edge-cases)
12. [File Structure](#12-file-structure)
13. [Setup and Run Instructions](#13-setup-and-run-instructions)
14. [Seed Data](#14-seed-data)

---

## 1. What We Are Building

A **clinic operations scheduling engine** for small medical practices. This is not a simple CRUD API. It is a constraint-satisfaction engine that computes booking availability from rules, enforces concurrency guarantees at the database level, maintains an immutable audit trail of every state transition, and isolates data across multiple clinic tenants.

The platform serves as the scheduling foundation that everything else — patient portals, doctor dashboards, billing integrations — will be built on top of. The data modelling and architectural decisions made here compound over years. Every shortcut taken now becomes structural debt.

### The Five Core Problems

**Problem 1 — Availability is a formula, not data.**
A doctor's bookable schedule is defined by a weekly recurring template plus date-specific exceptions. Available slots are never stored — they are computed at query time by applying the template, overlaying exceptions, and subtracting already-booked appointments. This means schedule changes take effect instantly without any regeneration job.

**Problem 2 — Slot computation must be fast at scale.**
The `/slots` endpoint runs this formula for every date in a query window (up to 30 days) across a potentially busy doctor's calendar. Without the right query strategy and indexes, this becomes a collection scan on every request.

**Problem 3 — Double-booking must be structurally impossible.**
Two patients attempting to book the same slot at the same millisecond cannot both succeed. There is no `SELECT FOR UPDATE` in MongoDB. The solution is a dedicated slot reservation document protected by a tenant-scoped partial unique index — the database itself is the arbiter, not application-level locking.

**Problem 4 — Every state transition is an immutable event.**
Every write to an appointment document — creation, confirmation, reschedule, cancellation, no-show, completion, hold expiry — produces a corresponding event document that is never updated or deleted. Appointment updates and event writes must be committed in the same MongoDB transaction. The current state of any appointment must be derivable from its event log alone. This is a compliance and audit requirement.

**Problem 5 — 50+ clinic tenants must be hard-isolated.**
A missing `clinicId` filter must not silently expose another clinic's appointments. Isolation is enforced at both the application layer (middleware injects clinicId from auth token) and the data layer (clinicId on every document, compound indexes that include clinicId).

---

## 2. Tech Stack and Why

| Layer | Choice | Reason |
|---|---|---|
| Language | JavaScript (ES modules) | Matches team choice; all app source uses `.js` files |
| Runtime | Node.js | Async I/O fits concurrent booking pattern well |
| Framework | Express | Minimal, well-understood, no magic |
| Database | MongoDB replica set | Native atomic writes, unique indexes, transactions for audit-safe state changes, document model fits availability rules |
| ODM | Mongoose | Schema validation, middleware hooks for event log, optimistic concurrency via versionKey |
| Timezone | luxon | Correct DST handling for local-time availability windows |
| Validation | zod | Schema-first validation, clean error messages |
| Containerisation | Docker Compose | Single command setup, reproducible environment |

### Why MongoDB Over a Relational Database

The weekly availability template is a naturally hierarchical document — a map of days to arrays of local-time windows. Date-specific exceptions are separate documents because they are range queried by date. In a relational model this requires multiple tables and joins on every slot query. In MongoDB the recurring template is one document fetch, and exceptions are a bounded indexed range query.

The tenant-scoped partial unique index on `slotReservations` gives exactly the concurrency primitive needed for booking. MongoDB transactions are used where correctness requires two writes to succeed together, especially appointment state changes plus immutable event-log inserts.

### Where MongoDB Fights You

- Atomic update methods do not trigger Mongoose `pre/post save` hooks. Event log writes must be implemented at the service layer, not the model layer.
- TTL cleanup, if used for old inactive reservation cleanup, is not exact and does not write audit events. Hold expiry must be handled by application logic that records an `expired` event.
- Multi-document transactions require a replica set. Production must run MongoDB as a replica set, including local Docker setup, because audit correctness depends on committing appointment updates and event writes together.

---

## 3. System Architecture

```
Request
  │
  ▼
Express Router
  │
  ├── auth middleware        (verify token, extract actorId + role)
  ├── tenant middleware      (inject clinicId from token, enforce on every query)
  └── validate middleware    (zod schema validation, reject 400 before DB touch)
  │
  ▼
Controller                  (HTTP concern only — parse req, call service, format res)
  │
  ▼
Service Layer
  ├── slot.engine.js         (pure computation: template + exceptions + reservations → slots)
  ├── booking.service.js     (owns reservation claims and booking state transitions)
  ├── availability.service.js
  ├── event.service.js       (writes immutable events inside transaction sessions)
  └── waitlist.service.js
  │
  ▼
Mongoose Models             (schema + indexes defined here)
  │
  ▼
MongoDB
```

### Key Architectural Decisions

**Slot computation is pure.** `slot.engine.js` takes availability templates, date exceptions, and slot reservation data as inputs and returns available slots. It has no database calls. This makes it testable in isolation and cacheable if needed.

**Booking service owns concurrency.** The atomic reservation claim lives in exactly one place — `booking.service.js`. No other code path creates or transitions slot reservations without going through this service.

**Event log is a service concern, not a model hook.** Because atomic update methods do not fire Mongoose `save` hooks, the event write is called explicitly in `event.service.js` inside the same MongoDB transaction as the appointment or reservation mutation.

**Tenant middleware is not optional.** Every route is wrapped with the tenant middleware. It reads `clinicId` from the verified auth token and attaches it to `req.clinicId`. Every service function receives `clinicId` as a parameter and includes it in every query filter. A query without `clinicId` in the filter is a bug.

---

## 4. Data Model

### Collection: `clinics`

```json
{
  "_id": "clinic_01HX4K2M...",
  "name": "Sharma Medical Centre",
  "timezone": "Asia/Kolkata",
  "address": {
    "line1": "42 MG Road",
    "city": "Bengaluru",
    "state": "Karnataka",
    "pincode": "560001"
  },
  "contactEmail": "admin@sharmamedical.in",
  "contactPhone": "+91-80-12345678",
  "isActive": true,
  "createdAt": "2025-06-01T06:30:00Z",
  "updatedAt": "2025-06-01T06:30:00Z"
}
```

**Why timezone lives on the clinic:** Availability windows are stored as local time strings ("09:00", "18:00"). UTC conversion happens at query time using the clinic's timezone. A clinic in Mumbai and one in London both store "09:00" but mean very different UTC offsets, and that offset shifts with DST. Storing timezone at the clinic level means you never need to store it anywhere else.

---

### Collection: `doctors`

```json
{
  "_id": "dr_01HX4K2N...",
  "clinicId": "clinic_01HX4K2M...",
  "name": "Dr. Priya Sharma",
  "specialisation": "General Physician",
  "email": "priya.sharma@sharmamedical.in",
  "supportedAppointmentTypes": ["appttype_01...", "appttype_02..."],
  "isActive": true,
  "createdAt": "2025-06-01T06:30:00Z",
  "updatedAt": "2025-06-01T06:30:00Z"
}
```

**Embedding vs referencing supportedAppointmentTypes:** Referenced by ID, not embedded. Appointment types belong to the clinic and can be updated independently. If embedded, updating a type duration would require updating every doctor document. Referenced means one update, consistent everywhere.

---

### Collection: `appointmentTypes`

```json
{
  "_id": "appttype_01HX...",
  "clinicId": "clinic_01HX4K2M...",
  "name": "General Consult",
  "durationMinutes": 15,
  "color": "#4A90E2",
  "requiresSpecialisation": null,
  "isActive": true,
  "createdAt": "2025-06-01T06:30:00Z"
}
```

**Why duration lives here:** The slot engine reads `durationMinutes` to compute slot boundaries. Every slot query resolves the appointment type first, then uses its duration to step through availability windows. Changing duration here instantly affects all future slot computations without any migration.

---

### Collection: `availabilityTemplates`

One active weekly template per doctor. This document stores recurring rules only. Date-specific exceptions live in a separate collection so 30-day slot queries read only the exceptions they need.

```json
{
  "_id": "avail_01HX...",
  "doctorId": "dr_01HX4K2N...",
  "clinicId": "clinic_01HX4K2M...",
  "weeklyTemplate": {
    "MON": [
      { "start": "09:00", "end": "13:00" },
      { "start": "15:00", "end": "18:00" }
    ],
    "TUE": [
      { "start": "10:00", "end": "17:00" }
    ],
    "WED": [
      { "start": "09:00", "end": "13:00" },
      { "start": "15:00", "end": "18:00" }
    ],
    "THU": [
      { "start": "10:00", "end": "17:00" }
    ],
    "FRI": [
      { "start": "09:00", "end": "13:00" },
      { "start": "15:00", "end": "18:00" }
    ],
    "SAT": [],
    "SUN": []
  },
  "version": 4,
  "isActive": true,
  "updatedAt": "2025-06-01T06:30:00Z"
}
```

**Why times are stored as local strings, not UTC:** The template repeats every week. "MON 09:00–13:00" means Monday at 9am in the clinic's local timezone, every week, forever — including across DST transitions. If stored as UTC offsets, a summer schedule would shift by one hour in winter. Storing as local strings with UTC conversion at query time (using the clinic timezone) is the only correct approach.

### Collection: `availabilityExceptions`

```json
{
  "_id": "ex_01HX...",
  "clinicId": "clinic_01HX4K2M...",
  "doctorId": "dr_01HX4K2N...",
  "date": "2025-06-11",
  "type": "override",
  "windows": [{ "start": "10:00", "end": "14:00" }],
  "reason": "Half day",
  "createdBy": "staff_01HX...",
  "createdAt": "2025-06-01T06:30:00Z",
  "updatedAt": "2025-06-01T06:30:00Z"
}
```

**Why exceptions are separate documents:** Exceptions are range queried by date. A 30-day slot query should not read a doctor's entire exception history. A separate collection with `{ clinicId, doctorId, date }` lets the engine fetch only relevant exceptions and avoids a single ever-growing availability document. It also reduces document-level write contention when calendar sync, staff edits, and doctor edits all touch exceptions.

**Why no pre-materialised slots collection:** If slots were pre-computed and stored, every schedule change would require regenerating slots for all affected future dates. With busy doctors and long booking windows, this becomes a background job that runs constantly and has complex invalidation logic. Computing from the template at query time means schedule changes take effect instantly, with no regeneration, no stale data, and no job to manage.

---

### Collection: `appointments`

```json
{
  "_id": "appt_01HX...",
  "clinicId": "clinic_01HX4K2M...",
  "doctorId": "dr_01HX4K2N...",
  "patientId": "patient_01HX...",
  "appointmentTypeId": "appttype_01HX...",
  "appointmentTypeName": "General Consult",
  "durationMinutes": 15,
  "currentReservationId": "res_01HX...",
  "currentSlotStart": "2025-06-15T03:30:00Z",
  "currentSlotEnd": "2025-06-15T03:45:00Z",
  "status": "confirmed",
  "version": 3,
  "idempotencyKey": "client_generated_uuid",
  "patient": {
    "name": "Rahul Verma",
    "phone": "+91-98765-43210",
    "email": "rahul@example.com"
  },
  "notes": "Follow up on blood pressure medication",
  "cancelledBy": null,
  "cancellationReason": null,
  "createdAt": "2025-06-10T04:00:00Z",
  "updatedAt": "2025-06-14T10:00:00Z"
}
```

**Why patient is embedded:** Patient information at time of booking is a snapshot. If the patient updates their phone number later, the appointment record should still reflect what was true when they booked. Embedding also means one fewer DB lookup when fetching appointment details. The patient collection (if it exists) is the source of truth for current patient info; the appointment document is the source of truth for what was recorded at booking time.

**Why durationMinutes is denormalised here:** The appointment should preserve the duration that was true at booking time. If the appointment type duration changes later, already-booked appointments keep their original duration.

**The version field:** This is the optimistic concurrency lock. Every update increments version. A concurrent update that sends `version: 2` when the document is already at `version: 3` fails — the filter `{ _id, version: 2 }` matches nothing. The caller knows to retry with fresh data.

**The idempotencyKey field:** A unique index on this field prevents duplicate appointments from network retries. The client generates a UUID before sending the booking request. If the request is retried due to a timeout, MongoDB rejects the second insert with a duplicate key error, and the API returns the original appointment instead of creating a second one.

---

### Collection: `slotReservations`

Slot reservations are the database-enforced booking lock. They are separate from appointments so the appointment remains a stable business entity across reschedules, payments, reminders, notes, and external integrations.

```json
{
  "_id": "res_01HX...",
  "clinicId": "clinic_01HX4K2M...",
  "doctorId": "dr_01HX4K2N...",
  "appointmentId": "appt_01HX...",
  "appointmentTypeId": "appttype_01HX...",
  "durationMinutes": 15,
  "slotStart": "2025-06-15T03:30:00Z",
  "slotEnd": "2025-06-15T03:45:00Z",
  "slotStartLocal": "2025-06-15T09:00:00",
  "status": "held",
  "holdExpiresAt": "2025-06-15T03:35:00Z",
  "releasedAt": null,
  "createdAt": "2025-06-15T03:30:00Z",
  "updatedAt": "2025-06-15T03:30:00Z"
}
```

Status values: `held`, `confirmed`, `released`, `expired`.

**Why reservations are separate:** The unique constraint belongs to the resource/time claim, not the patient-facing appointment identity. Rescheduling should change which reservation an appointment points to, not create a completely new appointment record and force every downstream system to follow a replacement chain.

**Why expired holds are not simply deleted:** Hold expiry is a state transition and must produce an event. The system lazily marks expired held reservations as `expired` inside the booking path or confirm path. TTL may be used later for old `expired` or `released` reservation cleanup after the audit retention period, but never as the primary mechanism for state transition.

---

### Collection: `appointmentEvents`

```json
{
  "_id": "evt_01HX...",
  "appointmentId": "appt_01HX...",
  "clinicId": "clinic_01HX4K2M...",
  "eventType": "rescheduled",
  "timestamp": "2025-06-14T10:00:00Z",
  "actor": {
    "id": "staff_01HX...",
    "role": "clinic_staff",
    "name": "Meena Iyer"
  },
  "previousState": "confirmed",
  "newState": "confirmed",
  "metadata": {
    "previousSlotStart": "2025-06-15T03:30:00Z",
    "newSlotStart": "2025-06-16T04:00:00Z",
    "reason": "Patient requested change"
  }
}
```

Event types: `created`, `confirmed`, `rescheduled`, `cancelled`, `no_show`, `completed`, `expired`.

**Events are never updated or deleted.** The collection has no update or delete operations in the codebase. If an event is written incorrectly, a corrective event is appended — never a mutation of the existing one. This is enforced by having no update/delete routes for this collection and by setting MongoDB collection-level write concern that the application layer respects.

**The current state is derivable from the log alone.** Replaying events in timestamp order from `created` through all transitions gives you the current `status`. The `appointments` document is a materialised projection of this log — a read optimisation. Appointment mutations and event inserts are committed together in a transaction so this projection should not diverge during normal operation.

---

### Collection: `waitlistEntries`

```json
{
  "_id": "wait_01HX...",
  "clinicId": "clinic_01HX4K2M...",
  "doctorId": "dr_01HX4K2N...",
  "appointmentTypeId": "appttype_01HX...",
  "targetDate": "2025-06-15",
  "patientId": "patient_02HX...",
  "patient": {
    "name": "Sunita Rao",
    "phone": "+91-99887-76655"
  },
  "urgencyFlag": true,
  "status": "waiting",
  "joinedAt": "2025-06-10T08:00:00Z",
  "offeredAt": null,
  "offerExpiresAt": null,
  "offeredSlotStart": null
}
```

Waitlist status machine: `waiting → offered → accepted | expired_offer → waiting (next in queue)`.

---

### Collection: `slotOffers`

Waitlist offers are separate from waitlist entries so the database can enforce exactly one active offer per opened slot.

```json
{
  "_id": "offer_01HX...",
  "clinicId": "clinic_01HX4K2M...",
  "doctorId": "dr_01HX4K2N...",
  "appointmentTypeId": "appttype_01HX...",
  "waitlistEntryId": "wait_01HX...",
  "slotStart": "2025-06-15T03:30:00Z",
  "slotEnd": "2025-06-15T03:45:00Z",
  "status": "offered",
  "offerExpiresAt": "2025-06-15T03:45:00Z",
  "createdAt": "2025-06-15T03:30:00Z"
}
```

Status values: `offered`, `accepted`, `expired`, `declined`, `superseded`.

---

## 5. Indexes

Every index listed here exists for a specific query. No speculative indexes.

### `clinics`
```js
{ _id: 1 }  // default
```

### `doctors`
```js
{ clinicId: 1, isActive: 1 }        // list doctors for a clinic
{ clinicId: 1, _id: 1 }             // tenant-scoped lookup by id
```

### `appointmentTypes`
```js
{ clinicId: 1, isActive: 1 }        // list types for a clinic
```

### `availabilityTemplates`
```js
{ clinicId: 1, doctorId: 1, isActive: 1 }, { unique: true, partialFilterExpression: { isActive: true } }
// one active weekly template per doctor
```

### `availabilityExceptions`
```js
{ clinicId: 1, doctorId: 1, date: 1 }, { unique: true }
// fetch date-specific overrides for a doctor and date range; upsert by doctor/date
```

### `appointments`
```js
// current appointment lookup by doctor/status/date for staff views
{ clinicId: 1, doctorId: 1, status: 1, currentSlotStart: 1 }

// Tenant-scoped list queries
{ clinicId: 1, status: 1, currentSlotStart: 1 }

// Patient history
{ clinicId: 1, patientId: 1, currentSlotStart: -1 }

// Idempotency
{ clinicId: 1, idempotencyKey: 1 }, { unique: true, sparse: true }
```

### `slotReservations`
```js
// THE concurrency index — makes double-booking structurally impossible
{ clinicId: 1, doctorId: 1, slotStart: 1 }, {
  unique: true,
  partialFilterExpression: { status: { $in: ['held', 'confirmed'] } }
}

// slot engine conflict query
{ clinicId: 1, doctorId: 1, status: 1, slotStart: 1, slotEnd: 1 }

// lazy expiry lookup
{ clinicId: 1, status: 1, holdExpiresAt: 1 }
```

**Why a partial unique index, not a full unique index on `{ clinicId, doctorId, slotStart }`:**
A full unique index would prevent a doctor from ever reusing the same slot after a cancellation or expiry. The partial index scopes uniqueness only to active reservations: `held` and `confirmed`. `released` and `expired` reservations remain available for audit without blocking future bookings.

**Important limitation:** This unique index protects identical slot starts. The API must also reject arbitrary start times and only allow starts generated by the slot engine. Overlap checks still run before claim creation so variable-duration appointments cannot overlap.

### `appointmentEvents`
```js
{ appointmentId: 1, timestamp: 1 }  // fetch history in order
{ clinicId: 1, timestamp: -1 }      // clinic-level audit queries
```

### `waitlistEntries`
```js
{ clinicId: 1, doctorId: 1, targetDate: 1, appointmentTypeId: 1, status: 1, urgencyFlag: -1, joinedAt: 1 }
// drives the ordered waitlist fetch: urgency first, then join time

{ clinicId: 1, patientId: 1, status: 1 }
// patient's own waitlist entries

{ clinicId: 1, doctorId: 1, targetDate: 1, appointmentTypeId: 1, patientId: 1 }, { unique: true }
// prevents duplicate waitlist entries from the same patient
```

### `slotOffers`
```js
{ clinicId: 1, doctorId: 1, appointmentTypeId: 1, slotStart: 1 }, {
  unique: true,
  partialFilterExpression: { status: 'offered' }
}
// exactly one active waitlist offer per opened slot

{ clinicId: 1, waitlistEntryId: 1, status: 1 }
// find active offers for a patient/waitlist entry
```

---

## 6. Slot Engine — How It Works

The slot engine is a pure function. It takes availability data and active reservation data, returns available slots. No side effects, no DB calls inside.

### Input
- Doctor's availability template
- Date-specific exceptions for the requested range
- Clinic timezone
- Appointment type duration in minutes
- Date range (from, to)
- All active slot reservations for the doctor in the date range: `confirmed` reservations and `held` reservations where `holdExpiresAt > now`

### Computation Pipeline

**Step 1 — Resolve effective windows for each date**

For each date in the range:
```
if exception exists for this date:
  if type === 'block'     → windows = []
  if type === 'override'  → windows = exception.windows
  if type === 'additional'→ windows = template[dayOfWeek] + exception.windows
else:
  windows = template[dayOfWeek]  (empty array if day not in template)
```

**Step 2 — Convert local windows to UTC**

Each window's start and end are local time strings ("09:00", "13:00"). Convert to UTC using the clinic timezone:
```js
const windowStartUTC = DateTime.fromObject(
  { year, month, day, hour: 9, minute: 0 },
  { zone: clinicTimezone }
).toUTC()
```

This must use a proper timezone library (luxon). Never use manual UTC offset arithmetic — DST transitions make it wrong.

**Step 3 — Generate candidate slots**

For each UTC window, generate slot start times by stepping through in `durationMinutes` increments:
```
slotStart = windowStart
while slotStart + duration <= windowEnd:
  candidates.push(slotStart)
  slotStart += duration
```

The last partial slot is dropped. If a 15-minute slot cannot complete before the window ends, it is not offered.

**Step 4 — Filter out occupied slots**

For each candidate slot, check if any existing active reservation occupies it:
```
slot is occupied if any active reservation satisfies:
  reservation.slotStart < candidateStart + duration
  AND reservation.slotEnd > candidateStart
```

This is an overlap check, not an equality check. A 30-minute reservation starting at 09:00 blocks the 09:00 and the 09:15 slots if the appointment type being queried is 15 minutes.

**Step 5 — Filter past slots**

Remove any slot where `slotStart < now`. Never return bookable slots in the past.

**Step 6 — Return**

```json
{
  "doctorId": "dr_01HX...",
  "appointmentType": "general_consult",
  "durationMinutes": 15,
  "slots": [
    { "start": "2025-06-15T03:30:00Z", "startLocal": "2025-06-15T09:00:00", "end": "2025-06-15T03:45:00Z" },
    { "start": "2025-06-15T03:45:00Z", "startLocal": "2025-06-15T09:15:00", "end": "2025-06-15T04:00:00Z" }
  ]
}
```

### Performance

The bottleneck is step 4 — the conflict check. The approach is:

1. Fetch all active reservations in the date range in one query (hits the compound index `{ clinicId, doctorId, status, slotStart, slotEnd }`).
2. Build an in-memory interval tree or sorted array of booked intervals.
3. For each candidate slot, do an O(log n) lookup against the in-memory structure.

This means three DB reads for a 30-day slot query — one for the weekly template, one for date-range exceptions, and one for active reservations. The computation is in-process. As the reservations collection grows, the index ensures the fetch stays fast. The in-memory conflict check scales with the number of reservations in the date range, not the total collection size.

### DST Edge Cases

On a DST transition day (clocks move forward), a 09:00–13:00 local window is 3 hours in UTC, not 4. On a DST fallback day, it is 5 hours. The slot engine handles this correctly because it converts each date's windows independently using the full date context, not a fixed offset.

---

## 7. Concurrency Strategy

### The Core Problem

Two patients request `POST /appointments` for the same slot at the same millisecond. Both read the slot as available. Both attempt to create an appointment. Without a database-level guarantee, both succeed — double-booking.

### The Atomic Operation

A partial unique index on `slotReservations`:
```js
{ clinicId: 1, doctorId: 1, slotStart: 1 }, {
  unique: true,
  partialFilterExpression: { status: { $in: ['held', 'confirmed'] } }
}
```

The booking operation first validates that the requested start time exactly matches one of the generated candidate slots. Then it claims the slot by inserting a reservation:
```js
try {
  const { appointment, reservation } = await withTransaction(async (session) => {
    const reservation = await SlotReservation.create([{
      clinicId,
      doctorId,
      appointmentTypeId,
      durationMinutes,
      slotStart,
      slotEnd,
      status: 'held',
      holdExpiresAt: new Date(Date.now() + 5 * 60 * 1000)
    }], { session })

    const appointment = await Appointment.create([{ ...rest, currentReservationId: reservation[0]._id, status: 'pending' }], { session })
    await eventService.write({ appointment, eventType: 'created', actor, session })
    return { appointment: appointment[0], reservation: reservation[0] }
  })

  return { appointment, reservation }
} catch (err) {
  if (err.code === 11000) {
    // duplicate key — another request won the race
    throw new ConflictError('This slot has just been taken. Please select another.')
  }
  throw err
}
```

MongoDB guarantees that for any given `{ clinicId, doctorId, slotStart }` combination, only one `held` or `confirmed` reservation can exist. The second insert hits the unique index and throws error code 11000. Exactly one request succeeds. This is atomic at the storage engine level — no application-level lock, no Redis lock.

The unique index protects identical generated slot starts. The service still performs an overlap check before insertion and rejects arbitrary start times. This matters because a unique index on `slotStart` alone cannot detect `09:00-09:30` overlapping with `09:15-09:30`.

### What the Losing Request Gets

HTTP 409 Conflict:
```json
{
  "error": {
    "code": "SLOT_TAKEN",
    "message": "This slot has just been taken. Please select another.",
    "details": { "slotStart": "2025-06-15T03:30:00Z" }
  }
}
```

The client should re-fetch `/slots` to show the patient updated availability and prompt them to choose again.

### Held-to-Expired Transition (No Tight Cron Job)

Holds expire logically after 5 minutes. The system does not rely on TTL deleting reservation documents because expiry is an auditable state transition.

The slot availability check explicitly filters:

```js
status: 'confirmed'
// OR
status: 'held', holdExpiresAt: { $gt: new Date() }
```

When a slot appears available but an expired `held` reservation still blocks the partial unique index, the booking service lazily expires it:

```js
await withTransaction(async (session) => {
  const expired = await SlotReservation.findOneAndUpdate(
    { clinicId, doctorId, slotStart, status: 'held', holdExpiresAt: { $lte: now } },
    { $set: { status: 'expired' } },
    { new: true, session }
  )
  if (expired) {
    await Appointment.updateOne(
      { _id: expired.appointmentId, clinicId, status: 'pending' },
      { $set: { status: 'expired' }, $inc: { version: 1 } },
      { session }
    )
    await eventService.write({ appointmentId: expired.appointmentId, eventType: 'expired', actor: systemActor, session })
  }
})
```

Then it retries the reservation insert once. This is lazy, bounded, auditable, and does not require a cron job running every second.

### Confirm Operation — Optimistic Concurrency

```js
const updated = await Appointment.findOneAndUpdate(
  {
    _id: appointmentId,
    clinicId,             // tenant check
    status: 'pending',
    version: currentVersion          // optimistic lock
  },
  {
    $set: { status: 'confirmed' },
    $inc: { version: 1 }
  },
  { new: true }
)

// In the same transaction, update the linked reservation:
// { status: 'held', holdExpiresAt: { $gt: now } } -> { status: 'confirmed' }
// and write the confirmed event.
```

### At 10,000 Concurrent Requests

The unique index is the bottleneck — MongoDB's WiredTiger engine serialises writes to the same index key. At 10,000 concurrent requests to the same slot, all 10,000 hit the index, one wins, 9,999 get 11000 errors instantly. No queue, no deadlock, no timeout. The losers fail fast.

The actual bottleneck at 10,000 concurrent requests is the connection pool, not the index. MongoDB connections are expensive. The application should be configured with a pool size appropriate for the expected concurrency (default Mongoose pool is 5 — far too low for production). At this scale, a connection pooler like PgBouncer's equivalent (or simply tuning `maxPoolSize` in Mongoose) is necessary.

---

## 8. Multi-Tenancy Model

### Strategy: `clinicId` Field on Every Document

Every document in every collection carries a `clinicId` field. Every query — reads and writes — includes `clinicId` in the filter. This is the simplest isolation strategy that works correctly at 50–500 clinics without operational complexity.

### Why Not Separate Collections or Databases Per Tenant

Separate collections per tenant (e.g. `appointments_clinic_abc`) require dynamic collection names in queries, make cross-clinic analytics impossible, and create index management overhead proportional to the number of tenants. At 500 clinics, that is 500 × N collections.

Separate databases per tenant give stronger isolation but require connection management per tenant, make connection pooling complex, and MongoDB Atlas charges per database in some configurations. The operational overhead is not justified until you have enterprise clients with contractual data residency requirements.

### Enforcement — Two Layers

**Layer 1 — Middleware (application layer)**

```js
// tenant.js middleware
export const enforceTenant = (req, res, next) => {
  const clinicId = req.auth.clinicId  // extracted from verified JWT
  if (!clinicId) return res.status(401).json({ error: 'No clinic context' })
  req.clinicId = clinicId             // attached to every request
  next()
}
```

Every service function signature includes `clinicId`:
```js
// booking.service.js
export const createAppointment = async (clinicId, doctorId, ...) => {
  // clinicId is always in the query filter — never optional
  const doctor = await Doctor.findOne({ _id: doctorId, clinicId })
  ...
}
```

**Layer 2 — Compound indexes (data layer)**

Every index that serves a list query includes `clinicId` as the first field. A query without `clinicId` cannot efficiently use any index — it would require a collection scan, which is both slow and a signal that something is wrong. Performance degradation acts as a secondary enforcement mechanism.

### Before and After Example

Without tenant isolation:
```js
// DANGEROUS — returns appointments from ALL clinics
const appointments = await Appointment.find({ doctorId, status: 'confirmed' })
```

With tenant isolation:
```js
// SAFE — scoped to authenticated clinic only
const appointments = await Appointment.find({
  clinicId: req.clinicId,   // from verified auth token, not from request body
  doctorId,
  status: 'confirmed'
})
```

### What Breaks at 500 Clinics

**Index cardinality:** The compound index `{ clinicId, status, currentSlotStart }` on appointments works well when clinics have similar appointment volumes. If one clinic has 10 million appointments and 499 others have 1,000 each, the index becomes unbalanced and queries for the large clinic slow down. Mitigation: shard the appointments and reservations collections by `clinicId` once you identify high-volume tenants.

**Connection pool contention:** 500 concurrent clinics all running slot computations share one connection pool. A slow query from one clinic delays others. Mitigation: per-clinic query timeout, circuit breaker pattern for queries exceeding threshold.

**High-volume tenants:** A few large clinics can dominate the shared collections and connection pool. Mitigation: every hot-path index starts with `clinicId`, slot queries have bounded date ranges, and the system can later shard high-volume collections by `clinicId` without changing application semantics.

---

## 9. Event Log Design

### Every State Transition Writes an Event

The state machine for appointments:

```
created → pending → confirmed → completed
                  → cancelled
                  → expired
confirmed → rescheduled (same appointment id, new reservation)
confirmed → no_show
confirmed → cancelled
```

### Event Write Pattern

The event write happens in `event.service.js` inside the same MongoDB transaction as the appointment or reservation mutation:

```js
export const writeEvent = async ({ appointment, eventType, actor, metadata = {}, session }) => {
  const event = new AppointmentEvent({
    appointmentId: appointment._id,
    clinicId: appointment.clinicId,
    eventType,
    timestamp: new Date(),
    actor: {
      id: actor.id,
      role: actor.role,
      name: actor.name
    },
    previousState: metadata.previousState || appointment.status,
    newState: appointment.status,
    metadata
  })
  await event.save({ session })
}
```

### Deriving State from the Log

```js
export const deriveCurrentState = (events) => {
  return events
    .sort((a, b) => a.timestamp - b.timestamp)
    .reduce((state, event) => event.newState, null)
}
```

The `GET /appointments/:id/history` endpoint returns events in chronological order. The final `newState` of the last event is the current state.

### Transaction Requirement

The appointment document update and the event insert must commit together. The production system runs MongoDB as a replica set and uses transactions for all state transitions:

```js
await session.withTransaction(async () => {
  const updated = await Appointment.findOneAndUpdate(filter, update, { session, new: true })
  await eventService.write({ appointment: updated, eventType, actor, metadata, session })
})
```

If either write fails, both are rolled back. A reconciliation job can still exist as an operational monitor, but it is not the primary correctness mechanism.

---

## 10. What We Gave Up By Not Using SQL

### 1. Multi-Step State Transitions Are More Operationally Expensive

Rescheduling an appointment is a multi-document operation: claim the new reservation, release the old reservation, update the appointment projection, and write an event. In PostgreSQL this would be a natural fit for relational constraints and serialisable transactions. In MongoDB it requires a replica set and explicit transaction boundaries.

Mitigation: all state transitions that touch appointments, reservations, and events run in MongoDB transactions. The unique reservation index still handles the hot-path race, while transactions protect the audit log and projection consistency.

### 2. Ad-Hoc Analytical Queries

The slot engine's conflict detection requires knowing which reservations overlap a given time window. In SQL this is a simple `WHERE slotStart < ? AND slotEnd > ?` query with relational joins available for doctor, appointment type, and tenant metadata. In MongoDB, the absence of joins means the slot engine fetches reservations in the date range and does the final overlap check in application memory. This is fine for bounded 30-day windows and normal doctor schedules. For reporting queries — "show me all appointment conflicts across all doctors in the past year" — MongoDB's aggregation pipeline becomes verbose and the lack of relational joins makes it harder.

Mitigation: accepted for the scheduling use case. Analytical and reporting queries would be better served by a periodic export to a data warehouse (BigQuery, Redshift) where SQL is available. The operational database is not the right tool for complex analytics regardless of whether it is relational or document-based.

---

## 11. All Endpoints — Logic, Constraints, Edge Cases

---

### Group 1 — Clinics and Doctors

---

#### `POST /clinics`

**Purpose:** Creates a new clinic. Every piece of data in the system hangs off a `clinicId`. This is the tenant root.

**Request body:**
```json
{
  "name": "Sharma Medical Centre",
  "timezone": "Asia/Kolkata",
  "address": { "line1": "42 MG Road", "city": "Bengaluru" },
  "contactEmail": "admin@sharmamedical.in",
  "contactPhone": "+91-80-12345678"
}
```

**Logic:**
- Generate a unique `clinicId`.
- Validate timezone is a valid IANA timezone string using luxon's `IANAZone.isValidZone()`. Reject freeform strings like "IST" or "GMT+5:30".
- Store with `isActive: true`.

**Response:** 201 with the created clinic document.

**Constraints:**
- Duplicate clinic names are allowed — two "City Health" clinics can exist. `clinicId` must be globally unique.
- Timezone is mandatory and must be valid IANA. This field cannot be changed after creation without a migration — the slot engine relies on it for all UTC conversions.

**Edge cases:**
- What if timezone is omitted? Reject with 400 — there is no safe default.
- What if contactEmail is not a valid email format? Reject with 400.

---

#### `POST /clinics/:clinicId/doctors`

**Purpose:** Creates a doctor scoped to a clinic.

**Request body:**
```json
{
  "name": "Dr. Priya Sharma",
  "specialisation": "General Physician",
  "email": "priya.sharma@sharmamedical.in",
  "supportedAppointmentTypes": ["appttype_01HX..."]
}
```

**Logic:**
- Verify `clinicId` in the URL matches the authenticated caller's clinic (tenant middleware).
- Verify all `supportedAppointmentTypes` IDs belong to this clinic — never accept cross-clinic type IDs.
- Store with `isActive: true`.

**Response:** 201 with the created doctor document.

**Edge cases:**
- Same person working at two clinics: create two separate doctor documents. Do not model shared identity across tenants.
- `supportedAppointmentTypes` empty array is allowed — a doctor can be created before types are assigned.
- `supportedAppointmentTypes` with an ID that does not exist or belongs to another clinic: reject with 400.

---

#### `GET /clinics/:clinicId/doctors`

**Purpose:** Lists all doctors for a clinic.

**Query params:** `isActive` (boolean, default true), `appointmentType` (filter by supported type), `page`, `limit`.

**Logic:**
- Enforce `clinicId` from auth token, not from URL param alone.
- Default to `isActive: true`. Inactive doctors should not appear in booking flows.
- Paginate — large clinics may have 50+ doctors.

**Response:** 200 with array of doctor documents and pagination metadata.

**Edge cases:**
- Request for a `clinicId` that does not match the caller's clinic: 403 Forbidden.
- No doctors found: 200 with empty array, not 404.

---

### Group 2 — Appointment Types

---

#### `POST /clinics/:id/appointment-types`

**Purpose:** Defines a bookable appointment type with its duration. The slot engine reads `durationMinutes` from here to compute slot boundaries.

**Request body:**
```json
{
  "name": "General Consult",
  "durationMinutes": 15,
  "color": "#4A90E2",
  "requiresSpecialisation": null
}
```

**Logic:**
- Validate `durationMinutes` is a positive integer. Recommended: multiples of 5.
- Store with `clinicId`, `isActive: true`.

**Response:** 201 with the created type document.

**Constraints:**
- Duration of 0 or negative: reject with 400.
- Duration greater than 480 minutes (8 hours): reject with 400 — no single appointment should span a full workday.

**Edge cases:**
- Changing duration on an existing type (via PATCH) does not affect already-confirmed appointments. Future slot computations use the new duration.
- A doctor can only be assigned types belonging to their own clinic.

---

#### `GET /clinics/:id/appointment-types`

**Purpose:** Returns all active appointment types for a clinic. Called by the booking UI to populate type selection.

**Response:** 200 with array of types.

**Edge cases:**
- Include `isActive: false` types only when `includeInactive=true` query param is passed. Default excludes inactive types.

---

#### `PATCH /appointment-types/:id`

**Purpose:** Updates a type's name, duration, or active status.

**Logic:**
- Verify the type's `clinicId` matches the caller's clinic.
- If `durationMinutes` changes, log a warning — this is a consequential change. Do not retroactively update any appointments.

**Edge cases:**
- Setting `isActive: false` does not cancel existing appointments with this type. It only prevents new bookings from using this type.
- Attempting to update a type belonging to a different clinic: 403 Forbidden.

---

### Group 3 — Availability

---

#### `PUT /doctors/:id/availability`

**Purpose:** Sets or replaces the doctor's weekly recurring template. This is a full replace operation — the entire template is sent and stored.

**Request body:**
```json
{
  "weeklyTemplate": {
    "MON": [{ "start": "09:00", "end": "13:00" }, { "start": "15:00", "end": "18:00" }],
    "TUE": [{ "start": "10:00", "end": "17:00" }],
    "WED": [{ "start": "09:00", "end": "13:00" }],
    "THU": [{ "start": "10:00", "end": "17:00" }],
    "FRI": [{ "start": "09:00", "end": "18:00" }],
    "SAT": [],
    "SUN": []
  }
}
```

**Logic:**
- Validate all time windows: `start` must be before `end`. No overlapping windows on the same day. No window shorter than the clinic's shortest appointment type duration.
- Times are stored as local strings. Do not convert to UTC at this stage.
- Upsert — if an active availability template already exists for this doctor, replace the `weeklyTemplate` field. Exceptions are stored separately and are unaffected.

**Constraints:**
- Time format must be `HH:MM` (24-hour). Reject `9:00`, `09:00:00`, `9am`.
- Day keys must be `MON`, `TUE`, `WED`, `THU`, `FRI`, `SAT`, `SUN`. No other values accepted.

**Edge cases:**
- What happens to existing confirmed appointments when the template changes? This endpoint does NOT invalidate them. The doctor must call `/availability/validate` first to see the impact. The template change only affects future slot computation.
- Removing a day from the template (setting it to empty array) means no new bookings on that day. Existing confirmed appointments on that day are unaffected.
- Overlapping windows on the same day (e.g. 09:00–13:00 and 12:00–15:00): reject with 400 with a specific error identifying the conflicting windows.

---

#### `GET /doctors/:id/availability`

**Purpose:** Returns the current template plus all future exceptions. The frontend needs both to render a calendar view accurately.

**Response:**
```json
{
  "doctorId": "dr_01HX...",
  "weeklyTemplate": { ... },
  "exceptions": [
    { "date": "2025-06-10", "type": "block", "reason": "Conference" }
  ]
}
```

**Edge cases:**
- If no availability template exists for this doctor, return 200 with an empty template — not 404. An empty template means the doctor has no availability configured, which is a valid state.
- Return only future exceptions (date >= today). Past exceptions are irrelevant to the booking UI.

---

#### `POST /doctors/:id/exceptions`

**Purpose:** Adds a date-specific override to the doctor's availability.

**Request body — three subtypes:**

Block (unavailable all day):
```json
{ "date": "2025-06-10", "type": "block", "reason": "Conference" }
```

Override (different hours than template):
```json
{ "date": "2025-06-11", "type": "override", "windows": [{ "start": "10:00", "end": "14:00" }], "reason": "Half day" }
```

Additional (extra hours beyond template):
```json
{ "date": "2025-06-12", "type": "additional", "windows": [{ "start": "19:00", "end": "21:00" }], "reason": "Evening clinic" }
```

**Logic:**
- Validate date is not in the past.
- Validate windows (same rules as template windows).
- Upsert by `{ clinicId, doctorId, date }` — only one exception per doctor per date. A second POST for the same date replaces the first.

**Constraints:**
- `block` type must not include `windows`.
- `override` and `additional` types must include at least one window.
- Date must be in `YYYY-MM-DD` format.

**Edge cases:**
- Exception created for a date that already has confirmed appointments in the blocked windows: exception is stored, appointments are NOT cancelled. Calling `/availability/validate` before applying the exception is the doctor's responsibility.
- Exception for a date the doctor doesn't work (e.g. Sunday in template): `additional` type is valid here — adding hours on a day not in the template.
- Two exceptions for the same date: second POST replaces the first (upsert). The response should indicate whether an existing exception was replaced.

---

#### `DELETE /doctors/:id/exceptions/:date`

**Purpose:** Removes a date-specific exception, reverting that date to the template.

**Logic:**
- Verify the exception belongs to this doctor and the doctor belongs to the caller's clinic.
- Delete the exception document from `availabilityExceptions`.

**Edge cases:**
- Deleting an exception that had added extra availability when someone has already booked in that extra window: exception is deleted, appointments remain. You are deleting a rule, not the appointments that were made under it.
- Deleting an exception for a date in the past: allow it (for data cleanliness) but it has no effect on slot computation.
- Deleting a non-existent exception: 404.

---

#### `POST /doctors/:id/availability/validate`

**Purpose:** Dry-run. Takes a proposed template change or exception and returns all confirmed appointments that would be invalidated. Does not apply any change.

**Request body:**
```json
{
  "proposedTemplate": { ... },
  "dateRange": { "from": "2025-06-10", "to": "2025-07-10" }
}
```

**Logic:**
1. Compute the set of windows the proposed schedule covers for each date in the range.
2. Query all `confirmed` appointments for this doctor in the date range using `currentSlotStart`.
3. For each appointment, check if its `currentSlotStart` and `currentSlotEnd` fit within a window of the proposed schedule.
4. Appointments that fall outside all windows are conflicts — return them.

**Response:**
```json
{
  "conflictCount": 3,
  "conflicts": [
    {
      "appointmentId": "appt_01HX...",
      "slotStart": "2025-06-15T03:30:00Z",
      "patientName": "Rahul Verma",
      "appointmentType": "General Consult"
    }
  ]
}
```

**Constraints:**
- `dateRange` is required — unbounded validation is rejected with 400.
- Maximum range: 90 days.

**Edge cases:**
- Zero conflicts: return 200 with `conflictCount: 0` and empty array — not 404.
- Proposed template identical to current: return 200 with zero conflicts.

---

### Group 4 — Slot Query Engine

---

#### `GET /slots`

**Query params:** `doctorId`, `clinicId`, `appointmentType`, `from`, `to`

All params required.

**Purpose:** Returns available booking slots computed at query time from the availability model. This is the core of the scheduling engine.

**Logic pipeline:**

1. Validate `clinicId` matches the authenticated caller's clinic and matches the doctor's clinic.
2. Fetch the doctor's active availability template.
3. Fetch the appointment type to get `durationMinutes`.
4. Verify the doctor supports this appointment type.
5. Fetch all active reservations for this doctor in the date range where `status` is `confirmed` OR (`status` is `held` AND `holdExpiresAt > now`).
6. For each date in `from`→`to`, resolve effective windows (template + exceptions logic).
7. Convert local windows to UTC using clinic timezone.
8. Generate candidate slots by stepping through windows in `durationMinutes` increments.
9. Filter out slots occupied by any active reservation (overlap check, not equality check).
10. Filter out slots where `slotStart < now`.
11. Return.

**Response:**
```json
{
  "doctorId": "dr_01HX...",
  "appointmentType": "general_consult",
  "durationMinutes": 15,
  "from": "2025-06-10",
  "to": "2025-06-15",
  "slots": [
    {
      "start": "2025-06-10T03:30:00Z",
      "startLocal": "2025-06-10T09:00:00",
      "end": "2025-06-10T03:45:00Z"
    }
  ]
}
```

**Constraints:**
- Maximum date range: 30 days. Reject with 400 if exceeded.
- `from` must not be more than 1 year in the past (allow some past queries for debugging but not unbounded).
- `to` must be after `from`.

**Edge cases:**
- `from` is today: include today's remaining slots. Any slot where `slotStart < now` is excluded.
- Appointment type not supported by this doctor: return 200 with empty slots array and a message, not 404.
- Doctor has no availability template: return 200 with empty slots array.
- Day has a `block` exception: no slots for that date.
- Slot duration does not divide evenly into a window (e.g. 30-minute slots in a 2.5-hour window): last partial slot dropped. Window 09:00–11:30 with 30-minute slots yields 09:00, 09:30, 10:00, 10:30, 11:00. Not 11:30 (incomplete).
- DST transition day: window start and end are converted independently using the full date context. A 09:00–13:00 window on a DST spring-forward day correctly represents 3 hours in UTC, not 4.
- Held reservation that is logically expired (`holdExpiresAt` in the past): the query excludes it from conflict checking. If its document still blocks the unique index, the booking path lazily marks it `expired` and retries once.
- Performance: the compound index `{ clinicId, doctorId, status, slotStart, slotEnd }` ensures the reservation fetch is a fast index scan regardless of total collection size.

---

### Group 5 — Appointments

---

#### `POST /appointments`

**Purpose:** Creates an appointment in `pending` status. This is where the concurrency guarantee is enforced.

**Request body:**
```json
{
  "doctorId": "dr_01HX...",
  "patientId": "patient_01HX...",
  "appointmentTypeId": "appttype_01HX...",
  "slotStart": "2025-06-15T03:30:00Z",
  "idempotencyKey": "client-uuid-here",
  "patient": {
    "name": "Rahul Verma",
    "phone": "+91-98765-43210",
    "email": "rahul@example.com"
  },
  "notes": "Blood pressure follow-up"
}
```

**Logic:**
1. Validate `slotStart` is in the future.
2. Verify doctor belongs to caller's clinic.
3. Verify appointment type belongs to caller's clinic and is supported by this doctor.
4. Compute `slotEnd` = `slotStart + durationMinutes`.
5. Verify `slotEnd` falls within one of the doctor's effective windows for that date — reject if the slot extends past a window boundary.
6. Check `idempotencyKey` — if a document with this key already exists, return it with 200 instead of creating a duplicate.
7. Verify `slotStart` exactly matches a candidate generated by the slot engine. Reject arbitrary overlapping starts.
8. Attempt to create a `held` slot reservation. The partial unique index on `{ clinicId, doctorId, slotStart }` for `held`/`confirmed` reservations enforces that exactly one booking wins.
9. If reservation insert succeeds: create the pending appointment and write the `created` event in the same MongoDB transaction, return 201.
10. If reservation insert throws error code 11000: check whether the blocker is an expired hold. If yes, lazily mark it expired with an event and retry once. Otherwise return 409 Conflict — slot taken.

**Response (success):** 201
```json
{
  "_id": "appt_01HX...",
  "status": "pending",
  "currentReservationId": "res_01HX...",
  "holdExpiresAt": "2025-06-15T04:05:00Z",
  "slotStart": "2025-06-15T03:30:00Z",
  "slotEnd": "2025-06-15T03:45:00Z"
}
```

**Response (conflict):** 409
```json
{
  "error": {
    "code": "SLOT_TAKEN",
    "message": "This slot has just been taken. Please select another."
  }
}
```

**Constraints:**
- `slotStart` must be a valid UTC ISO 8601 datetime string.
- The slot must be available — both the availability check and the atomic reservation insert are required. The availability check prevents obviously invalid requests from hitting the DB. The atomic insert is the actual concurrency guarantee.

**Edge cases:**
- Patient already has a confirmed appointment with this doctor at this time: detect in step 5 and reject with 409 — a patient cannot double-book themselves.
- `slotStart` is in the past: reject with 400 before touching the DB.
- `slotStart` falls on a `block` exception date for the doctor: reject with 400.
- `slotEnd` extends past the doctor's window end: reject with 400.
- Network timeout after insert succeeds but before 201 is returned: client retries with same `idempotencyKey`. Step 6 finds the existing document and returns it. No duplicate created.
- No `idempotencyKey` provided: proceed without idempotency protection. Consider making it required in production.

---

#### `PATCH /appointments/:id/confirm`

**Purpose:** Transitions `pending → confirmed`. Called after the patient completes the booking form.

**Logic:**
1. Fetch the appointment, verify `clinicId` matches caller's clinic.
2. Fetch the linked reservation and verify `status === 'held'` and `holdExpiresAt > now`.
3. In one MongoDB transaction, update appointment `pending → confirmed`, update reservation `held → confirmed`, increment appointment `version`, and write the `confirmed` event.
4. If no matching pending appointment or held reservation exists: determine why — expired hold or concurrent confirm already succeeded. Return 410 Gone for expired, 409 Conflict for concurrent.
5. Re-validate the slot is still within the doctor's schedule before committing the confirmation. If no longer valid, reject confirmation, release the hold, update the appointment, and write the appropriate event inside one transaction.

**Response (success):** 200 with updated appointment.

**Response (expired):** 410
```json
{ "error": { "code": "HOLD_EXPIRED", "message": "Your booking hold has expired. Please start again." } }
```

**Edge cases:**
- Confirm called twice concurrently: the `version` field in the filter ensures only one update matches. Second caller gets null result and receives 409.
- Doctor added a block exception for this date after pending was created: re-validation in step 5 catches this. Confirm is rejected, reservation is marked `released`, appointment is marked `cancelled`, event is written.
- Confirm called after 5 minutes: the `holdExpiresAt > now` check treats it as expired. Returns 410 and lazily writes an `expired` event if it has not been written already.

---

#### `PATCH /appointments/:id`  (Reschedule)

**Purpose:** Changes the confirmed appointment to a new slot while keeping the same appointment id.

**Request body:**
```json
{
  "newSlotStart": "2025-06-16T04:00:00Z",
  "reason": "Patient requested change"
}
```

**Logic:**
1. Fetch current appointment, verify ownership and `status === 'confirmed'`.
2. Validate `newSlotStart` is in the future and is a valid available slot (same checks as new booking).
3. Verify `newSlotStart` is not the same as current `currentSlotStart` — reject as no-op.
4. Attempt to create a new `confirmed` reservation for `newSlotStart` using the atomic reservation insert. This claims the new slot.
5. If the new slot claim fails (11000): return 409 — new slot is taken. Old appointment is untouched.
6. If the new slot claim succeeds: in the same transaction, mark the old reservation `released`, update the same appointment's `currentReservationId`, `currentSlotStart`, and `currentSlotEnd`, increment version, and write a `rescheduled` event.

**Response:** 200 with the same appointment document pointing to the new reservation.

**Edge cases:**
- Reschedule a `pending` appointment: allowed. Create a new held reservation, release the old held reservation, and keep the same appointment id.
- Reschedule a `cancelled` or `completed` appointment: reject with 400.
- New slot is the same as current slot: reject with 400 — detect before any DB operation.
- New slot overlaps with another of the patient's own appointments: detect and reject.
- Application crash between step 4 and step 6: prevented by wrapping claim, release, appointment update, and event write in one transaction.

---

#### `DELETE /appointments/:id`  (Cancel)

**Purpose:** Transitions an appointment to `cancelled` status.

**Request body:**
```json
{
  "cancelledBy": "patient",
  "reason": "Personal emergency"
}
```

**Logic:**
1. Fetch appointment, verify `clinicId` matches caller's clinic.
2. Verify status is `pending` or `confirmed`. Cannot cancel `cancelled`, `completed`, or `no_show` appointments.
3. In one transaction, update appointment to `cancelled`, mark the linked active reservation `released`, increment version, and write the `cancelled` event.
4. If a waitlist exists for this doctor + date + appointmentType, trigger the waitlist offer flow: fetch the top-priority entry and create a `slotOffers` document protected by the active-offer unique index.

**Response:** 200 with cancelled appointment.

**Edge cases:**
- Cancel a `pending` appointment: allowed. The slot is released. No need to find a new tenant — the slot can be booked immediately.
- Concurrent cancel requests for the same appointment: the `version` filter ensures only one succeeds. Second caller gets null result and receives 409.
- Cancelling an appointment that has waitlist entries: step 6 runs. If two cancellations happen simultaneously for slots that share a waitlist, the waitlist offer uses the same atomic pattern — only one offer is created.
- `cancelledBy` options: `patient`, `clinic_staff`, `system`. Only `clinic_staff` role can cancel on behalf of a patient.

---

#### `PATCH /appointments/:id/noshow`

**Purpose:** Clinic staff marks a confirmed appointment as `no_show` after the patient did not attend.

**Logic:**
1. Verify caller role is `clinic_staff` — patients cannot mark themselves as no-shows.
2. Verify `currentSlotStart < now` — cannot mark a future appointment as no-show.
3. Verify `status === 'confirmed'`.
4. Update status to `no_show`, write event.

**Edge cases:**
- `currentSlotStart` is in the future: reject with 400 — the appointment hasn't happened yet.
- Appointment already `cancelled`: reject with 400.
- Appointment already `completed`: reject with 400 — cannot go back to no-show from completed.

---

#### `PATCH /appointments/:id/complete`

**Purpose:** Marks a confirmed appointment as `completed` after the patient's visit.

**Logic:**
1. Verify caller role is `clinic_staff`.
2. Verify `currentSlotStart < now`.
3. Verify `status === 'confirmed'`.
4. Update status to `completed`, write event.

**Edge cases:**
- Same time constraint as no-show.
- Cannot complete a `cancelled` or `no_show` appointment.

---

#### `GET /appointments/:id`

**Purpose:** Returns a single appointment with current status.

**Logic:**
1. Fetch by `_id`.
2. Verify `clinicId` on the document matches caller's clinic — never return an appointment whose clinicId does not match.

**Response:** 200 with appointment document.

**Edge cases:**
- Appointment exists but belongs to a different clinic: 404 (not 403 — do not leak the existence of cross-clinic data).

---

#### `GET /appointments/:id/history`

**Purpose:** Returns the full immutable event log for an appointment in chronological order.

**Logic:**
1. Verify the appointment's `clinicId` matches caller's clinic.
2. Query `appointmentEvents` by `appointmentId`, sort by `timestamp` ascending.

**Response:**
```json
{
  "appointmentId": "appt_01HX...",
  "events": [
    {
      "eventType": "created",
      "timestamp": "2025-06-10T04:00:00Z",
      "actor": { "id": "patient_01HX...", "role": "patient", "name": "Rahul Verma" },
      "previousState": null,
      "newState": "pending",
      "metadata": {}
    },
    {
      "eventType": "confirmed",
      "timestamp": "2025-06-10T04:03:00Z",
      "actor": { "id": "patient_01HX...", "role": "patient", "name": "Rahul Verma" },
      "previousState": "pending",
      "newState": "confirmed",
      "metadata": {}
    }
  ]
}
```

**Edge cases:**
- Appointment with no events (should not happen in a healthy system but handle gracefully): return 200 with empty events array and log an alert.
- Very long event history (heavily rescheduled appointment): return all events without pagination. In practice, no single appointment should have more than 20–30 events.

---

#### `GET /clinics/:id/appointments`

**Purpose:** Lists appointments for a clinic with filters. Used by clinic staff dashboards.

**Query params:** `doctorId`, `date`, `status`, `from`, `to`, `patientId`, `page`, `limit`.

**Logic:**
1. Enforce `clinicId` from auth token — not from URL alone.
2. Require at least one of `date`, `from`/`to`, or `patientId` — unbounded queries rejected with 400.
3. Use cursor-based pagination (`after` cursor = last `_id` seen) — not offset pagination.

**Constraints:**
- Maximum date range: 90 days for staff queries.
- Maximum `limit`: 100 per page.

**Edge cases:**
- `from` without `to` or vice versa: reject with 400.
- Filtering by `patientId`: allowed, useful for patient history. Still scoped to `clinicId`.
- Offset pagination (`skip`) is explicitly avoided — as appointments are inserted, offset results drift. Cursor pagination is stable.

---

### Group 6 — Waitlist

---

#### `POST /appointments/:id/waitlist` (or `POST /waitlist`)

**Purpose:** Patient joins the waitlist for a fully-booked doctor, date, and appointment type combination.

**Request body:**
```json
{
  "doctorId": "dr_01HX...",
  "targetDate": "2025-06-15",
  "appointmentTypeId": "appttype_01HX...",
  "urgencyFlag": false
}
```

**Logic:**
1. Verify the slot is genuinely fully booked — if available slots exist, reject with 400 and tell the patient to book directly.
2. Check for existing waitlist entry for this patient + doctor + date + type combination (unique index).
3. Create waitlist entry with `status: 'waiting'`, `joinedAt: now`.

**Constraints:**
- Patient cannot join a waitlist for a slot that is available.
- Patient cannot join the same waitlist twice — deduplicated by `{ clinicId, doctorId, targetDate, appointmentTypeId, patientId }` unique index.

**Edge cases:**
- Patient joins waitlist, then the slot becomes available (cancellation offers it to someone higher in the queue who declines): the slot may re-open. The patient's waitlist entry remains active.
- `urgencyFlag` is set by the patient — consider requiring clinical staff to verify it in a real system. For this implementation, accept the patient's self-declaration.

---

#### `POST /waitlist/:id/accept`

**Purpose:** Patient accepts an offered slot within the 15-minute offer window.

**Logic:**
1. Fetch waitlist entry, verify `status === 'offered'` and `offerExpiresAt > now`.
2. Verify the linked `slotOffers` document is still `offered` and `offerExpiresAt > now`.
3. Attempt atomic booking of the offered slot using the same reservation mechanism as `POST /appointments`.
4. If booking succeeds: in one transaction, update waitlist entry status to `accepted`, update slot offer to `accepted`, and create the confirmed appointment.
5. If booking fails (slot re-taken): return 409 — expire this offer and advance to next waitlist entry.

**Edge cases:**
- Offer expired (`offerExpiresAt <= now`): return 410 Gone. Trigger next offer in the queue.
- Slot was re-booked by a direct booking between offer and acceptance: atomic reservation insert fails with 11000. Return 409. Mark this offer `superseded`, advance to next patient.
- Two patients somehow both try to accept (system error): only one atomic insert succeeds. Second gets 409.

---

#### `GET /doctors/:id/waitlist`

**Purpose:** Returns the ordered waitlist for a doctor. Clinic staff view.

**Logic:**
- Query waitlist entries for this doctor where `status` is `waiting` or `offered`.
- Order by `urgencyFlag: -1` (urgent first), then `joinedAt: 1` (earlier joiners first).

---

#### `DELETE /waitlist/:id`

**Purpose:** Patient removes themselves from the waitlist.

**Logic:**
- Verify the entry belongs to the authenticated patient.
- Verify `status` is `waiting` or `offered` — cannot remove an `accepted` entry.
- Delete the document.

**Edge cases:**
- Patient tries to remove someone else's waitlist entry: 403 Forbidden.
- Removing an `offered` entry: allowed. The slot offer is abandoned. Trigger the next offer in the queue.

---

## 12. File Structure

```
clinic-scheduling-engine/
├── .env.example
├── .gitignore
├── docker-compose.yml
├── package.json
├── docs/
│   ├── Task.md
│   ├── DataModel.md
│   ├── ApiContracts.md
│   ├── TestingPlan.md
│   └── CursorPlan.md
├── src/
│   ├── app.js
│   ├── server.js
│   ├── config/
│   │   ├── db.js
│   │   └── env.js
│   ├── models/
│   │   ├── Clinic.js
│   │   ├── Doctor.js
│   │   ├── AppointmentType.js
│   │   ├── AvailabilityTemplate.js
│   │   ├── AvailabilityException.js
│   │   ├── Appointment.js
│   │   ├── SlotReservation.js
│   │   ├── AppointmentEvent.js
│   │   ├── WaitlistEntry.js
│   │   └── SlotOffer.js
│   ├── routes/
│   │   ├── health.routes.js
│   │   ├── clinic.routes.js
│   │   ├── doctor.routes.js
│   │   ├── appointmentType.routes.js
│   │   ├── availability.routes.js
│   │   ├── slot.routes.js
│   │   ├── appointment.routes.js
│   │   └── waitlist.routes.js
│   ├── controllers/
│   │   ├── clinic.controller.js
│   │   ├── doctor.controller.js
│   │   ├── appointmentType.controller.js
│   │   ├── availability.controller.js
│   │   ├── slot.controller.js
│   │   ├── appointment.controller.js
│   │   └── waitlist.controller.js
│   ├── services/
│   │   ├── slot.engine.js
│   │   ├── booking.service.js
│   │   ├── appointment.service.js
│   │   ├── availability.service.js
│   │   ├── event.service.js
│   │   └── waitlist.service.js
│   ├── middleware/
│   │   ├── auth.js
│   │   ├── tenant.js
│   │   ├── validate.js
│   │   └── error.js
│   ├── validators/
│   │   ├── clinic.validator.js
│   │   ├── doctor.validator.js
│   │   ├── appointmentType.validator.js
│   │   ├── availability.validator.js
│   │   ├── slot.validator.js
│   │   ├── appointment.validator.js
│   │   └── waitlist.validator.js
│   └── utils/
│       ├── timezone.js
│       ├── slot.utils.js
│       ├── transactions.js
│       ├── ids.js
│       └── errors.js
├── openapi/
│   └── openapi.yaml
├── postman/
│   └── ClinicOS.postman_collection.json
├── tests/
│   ├── slot.engine.test.js
│   ├── booking.concurrency.test.js
│   ├── appointment-transitions.test.js
│   ├── slots.api.test.js
│   └── waitlist.test.js
└── scripts/
    ├── seed.js
    ├── setup-indexes.js
```

---

## 13. Setup and Run Instructions

```bash
# Clone and enter the project
git clone <repo-url>
cd clinic-scheduling-engine

# Copy environment variables
cp .env.example .env

# Start MongoDB and the API server
docker compose up

# In a separate terminal, run the seed script
npm run seed

# Verify the API is running
curl http://localhost:3000/health

# Open Swagger UI
open http://localhost:3000/api-docs

# Postman: set jwtSecret / jwtExpiresIn in environment to match .env (tokens auto-signed)
```

**Environment variables (.env.example):**
```
PORT=3000
MONGODB_URI=mongodb://mongo:27017/clinic_scheduling
JWT_SECRET=your-secret-here
JWT_EXPIRES_IN=7d
NODE_ENV=development
MAX_SLOT_QUERY_DAYS=30
PENDING_HOLD_MINUTES=5
WAITLIST_OFFER_MINUTES=15
```

---

## 14. Seed Data

The seed script (`scripts/seed.js`) creates:

- 2 clinics: one in `Asia/Kolkata`, one in `Europe/London`
- 3 doctors per clinic (6 total)
- 2–3 appointment types per clinic
- 30 days of availability for each doctor (weekly template)
- Sample exceptions: 2 per doctor (one block, one override)
- 10 sample confirmed appointments spread across doctors and dates
- 2 sample waitlist entries

This gives the slot engine meaningful data to compute against and demonstrates the template + exception model working together across timezones.
