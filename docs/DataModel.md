# Clinic Scheduling Engine — Data Model and Indexes

This file is the implementation-focused data model extracted from `docs/Task.md`. If there is a conflict, `docs/Task.md` is the source of truth.

**HTTP API:** OpenAPI at `openapi/openapi.yaml`, Swagger UI at `/api-docs`, manual E2E via `npm run e2e:curl` (see `docs/ApiContracts.md`).

## Core Rules

- `clinicId` exists on every tenant-owned document.
- Every hot-path query and index starts with `clinicId`.
- Slots are never pre-materialised.
- Available slots are derived at query time from `availabilityTemplates`, `availabilityExceptions`, and active `slotReservations`.
- Appointment documents are long-lived business records.
- `slotReservations` are the database-enforced booking locks.
- Expired holds are not deleted as the primary state transition. They are marked `expired` and an event is written.
- Appointment state changes and appointment event writes happen in the same MongoDB transaction.
- MongoDB must run as a replica set in local and production environments because transactions are required.

## Collections

> Auth layer note: scheduling collections are listed first.
> The `users` auth collection is implemented and included in the "Auth Model Extension" section below. `authSessions` remains optional/future.

### `clinics`

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

Reasoning:
- Clinic is the tenant root.
- `timezone` is mandatory and must be a valid IANA zone.
- Availability windows are local clinic times and are converted to UTC at query time with Luxon.

Indexes:

```js
{ _id: 1 }
```

### `doctors`

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

Reasoning:
- Appointment types are referenced by ID, not embedded.
- Updating appointment type metadata should not require rewriting every doctor document.
- Same doctor working at two clinics is represented as two doctor documents.

Indexes:

```js
{ clinicId: 1, isActive: 1 }
{ clinicId: 1, _id: 1 }
```

### `appointmentTypes`

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

Reasoning:
- `durationMinutes` drives slot generation.
- Changing a type duration affects future slot queries only.
- Already-created appointments keep their denormalised duration.

Indexes:

```js
{ clinicId: 1, isActive: 1 }
```

### `availabilityTemplates`

One active weekly template per doctor.

```json
{
  "_id": "avail_01HX...",
  "clinicId": "clinic_01HX4K2M...",
  "doctorId": "dr_01HX4K2N...",
  "weeklyTemplate": {
    "MON": [
      { "start": "09:00", "end": "13:00" },
      { "start": "15:00", "end": "18:00" }
    ],
    "TUE": [{ "start": "10:00", "end": "17:00" }],
    "WED": [
      { "start": "09:00", "end": "13:00" },
      { "start": "15:00", "end": "18:00" }
    ],
    "THU": [{ "start": "10:00", "end": "17:00" }],
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

Reasoning:
- Store local time strings, not UTC.
- The template repeats weekly forever.
- UTC offsets change across DST, so conversion must happen per date.
- Exceptions are not embedded because 30-day slot queries should read only exceptions inside the requested range.

Indexes:

```js
{ clinicId: 1, doctorId: 1, isActive: 1 }, {
  unique: true,
  partialFilterExpression: { isActive: true }
}
```

### `availabilityExceptions`

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

Types:
- `block`: full-day unavailable, no windows.
- `override`: replace template windows for that date.
- `additional`: add windows outside the template for that date.

Reasoning:
- Exceptions are range queried by date.
- A doctor may accumulate years of exceptions.
- Separate documents avoid one ever-growing availability document.
- Separate documents reduce write contention when staff, sync jobs, and doctors edit different dates.

Indexes:

```js
{ clinicId: 1, doctorId: 1, date: 1 }, { unique: true }
```

### `appointments`

Appointments are the stable business records.

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

Statuses:
- `pending`
- `confirmed`
- `cancelled`
- `expired`
- `no_show`
- `completed`

Reasoning:
- Patient snapshot is embedded because appointment records should preserve the details captured at booking time.
- Duration is denormalised so existing appointments do not change when appointment type duration changes.
- `version` is used for optimistic concurrency.
- `idempotencyKey` protects against duplicate appointments from client retries.
- Rescheduling keeps the same appointment ID and points to a new reservation.

Indexes:

```js
{ clinicId: 1, doctorId: 1, status: 1, currentSlotStart: 1 }
{ clinicId: 1, status: 1, currentSlotStart: 1 }
{ clinicId: 1, patientId: 1, currentSlotStart: -1 }
{ clinicId: 1, idempotencyKey: 1 }, { unique: true, sparse: true }
```

### `slotReservations`

Slot reservations are the concurrency lock.

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

Statuses:
- `held`
- `confirmed`
- `released`
- `expired`

Reasoning:
- The unique constraint belongs to the resource/time claim.
- Keeping reservations separate prevents reschedules from fragmenting appointment identity.
- Expired holds are marked `expired` and logged. They are not simply deleted.

Indexes:

```js
{ clinicId: 1, doctorId: 1, slotStart: 1 }, {
  unique: true,
  partialFilterExpression: { status: { $in: ['held', 'confirmed'] } }
}

{ clinicId: 1, doctorId: 1, status: 1, slotStart: 1, slotEnd: 1 }
{ clinicId: 1, status: 1, holdExpiresAt: 1 }
```

Important limitation:
- The unique index prevents identical active slot starts.
- The booking API must also reject arbitrary start times and only accept starts generated by the slot engine.
- The service must run an overlap check before claim creation so variable-duration appointments cannot overlap.

### `appointmentEvents`

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

Event types:
- `created`
- `confirmed`
- `rescheduled`
- `cancelled`
- `no_show`
- `completed`
- `expired`

Reasoning:
- Events are immutable and append-only.
- No update/delete routes should exist for this collection.
- Every appointment state transition writes an event.
- Appointment update and event insert happen in the same transaction.
- The appointment document is a projection; the event log must be able to derive current state.

Indexes:

```js
{ appointmentId: 1, timestamp: 1 }
{ clinicId: 1, timestamp: -1 }
```

### `waitlistEntries`

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

Status flow:
- `waiting`
- `offered`
- `accepted`
- `expired_offer`

Ordering:
- urgency flag first
- then time of joining

Indexes:

```js
{ clinicId: 1, doctorId: 1, targetDate: 1, appointmentTypeId: 1, status: 1, urgencyFlag: -1, joinedAt: 1 }
{ clinicId: 1, patientId: 1, status: 1 }
{ clinicId: 1, doctorId: 1, targetDate: 1, appointmentTypeId: 1, patientId: 1 }, { unique: true }
```

### `slotOffers`

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

Statuses:
- `offered`
- `accepted`
- `expired`
- `declined`
- `superseded`

Reasoning:
- Waitlist offers are separate so the DB can enforce exactly one active offer per opened slot.

Indexes:

```js
{ clinicId: 1, doctorId: 1, appointmentTypeId: 1, slotStart: 1 }, {
  unique: true,
  partialFilterExpression: { status: 'offered' }
}

{ clinicId: 1, waitlistEntryId: 1, status: 1 }
```

## Auth Model Extension

### `users` (implemented)

Purpose:
- clinic-scoped login identity for `patient` and `clinic_staff`.
- source of truth for JWT claims (`sub`, `clinicId`, `role`, `name`) after login is added.

Core fields (target):
- `_id`
- `clinicId`
- `email` (lowercased)
- `passwordHash`
- `role` (`patient` | `clinic_staff`)
- `name`
- `isActive`
- timestamps

Indexes (target):

```js
{ clinicId: 1, email: 1 }, { unique: true }
{ clinicId: 1, role: 1, isActive: 1 }
{ clinicId: 1, _id: 1 }
```

### `authSessions` (optional/future)

Purpose:
- refresh token session tracking, revocation, and logout.

Core fields (target):
- `_id`
- `userId`
- `clinicId`
- `refreshTokenHash`
- `status` (`active` | `revoked`)
- `expiresAt`
- metadata (`ip`, `userAgent`)

Indexes (target):

```js
{ refreshTokenHash: 1 }, { unique: true }
{ userId: 1, status: 1 }
{ clinicId: 1, userId: 1, status: 1 }
{ expiresAt: 1 } // optional TTL/expiry cleanup strategy
```

### Indexing impact of auth layer extension

- Existing scheduling/concurrency indexes remain unchanged.
- `clinicId` remains the first key in tenant-owned hot-path indexes.
- `patientId` in appointments/waitlist can move from free-form string to `users._id` without changing index shapes.
- Core uniqueness locks (`slotReservations`, `slotOffers`) stay exactly as-is.

## Transaction Rules

Use MongoDB transactions for:
- appointment creation + reservation creation + created event
- confirm appointment + confirm reservation + confirmed event
- cancel appointment + release reservation + cancelled event
- reschedule appointment + create new reservation + release old reservation + rescheduled event
- expire held reservation + expire appointment + expired event
- waitlist offer acceptance + appointment/reservation creation + offer update + waitlist update

Do not use Mongoose hooks for audit events. Event writes must be explicit service calls inside transaction sessions.

## Multi-Tenancy Rules

- `clinicId` comes from the verified auth token, not request body.
- URL `clinicId` must match authenticated `clinicId`.
- Cross-clinic document IDs are rejected with 403 or hidden as 404 where existence should not leak.
- Every service function receives `clinicId`.
- Every query filter includes `clinicId`.
- Every list or hot-path index starts with `clinicId`.

