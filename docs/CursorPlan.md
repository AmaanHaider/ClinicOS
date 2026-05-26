# Clinic Scheduling Engine — Cursor Implementation Plan

Use this file to drive Cursor step by step. `docs/Task.md` is the master architecture spec. `docs/DataModel.md`, `docs/ApiContracts.md`, and `docs/TestingPlan.md` are implementation references.

**Implementation language:** JavaScript only (Node.js ES modules, `.js` extensions). All file paths in this plan use `.js`. Do not introduce TypeScript, `tsconfig.json`, or `.ts` source files.

Do not ask Cursor to build the whole system in one prompt. Work one checkpoint at a time.

## Cursor Ground Rules

Give Cursor these rules at the start of every major implementation session:

```txt
Read docs/Task.md, docs/DataModel.md, docs/ApiContracts.md, and docs/TestingPlan.md before coding.
Use JavaScript (.js) only — no TypeScript.
Implement only the checkpoint I ask for.
Do not skip tests for the checkpoint.
Do not create a pre-materialized slots collection.
All tenant-owned documents and queries must include clinicId.
Booking concurrency must be enforced by slotReservations partial unique index, not application locks.
Appointment mutations and appointmentEvents writes must be in the same MongoDB transaction.
MongoDB must run as a replica set.
```

## Checkpoint 0 — Planning Only

Prompt:

```txt
Read docs/Task.md, docs/DataModel.md, docs/ApiContracts.md, and docs/TestingPlan.md. Do not write application code. Summarize the implementation plan as small checkpoints and list any ambiguities before coding.
```

Expected output:
- Cursor confirms the architecture.
- Cursor does not change code.
- Cursor identifies no contradiction around appointments vs slotReservations.

## Checkpoint 1 — Project Scaffold

Goal:
- Create Node.js + JavaScript + Express project.
- Add Docker Compose with MongoDB replica set.
- Add env config.
- Add health endpoint.
- Add test framework.

Files to create:

```txt
package.json

.env.example
.gitignore
docker-compose.yml
src/app.js
src/server.js
src/config/env.js
src/config/db.js
src/routes/health.routes.js
src/middleware/error.js
src/utils/errors.js
tests/health.test.js
```

Prompt:

```txt
Implement Checkpoint 1 from docs/CursorPlan.md. Scaffold a JavaScript Express API with MongoDB replica set Docker Compose, env parsing, DB connection, health route, central error middleware, and a basic health test. Do not implement scheduling models or routes yet.
```

Acceptance:
- `docker compose up` starts MongoDB replica set and API.
- `/health` returns 200.
- `.env.example` includes:
  - `PORT`
  - `MONGODB_URI`
  - `JWT_SECRET`
  - `JWT_EXPIRES_IN`
  - `NODE_ENV`
  - `MAX_SLOT_QUERY_DAYS=30`
  - `PENDING_HOLD_MINUTES=5`
  - `WAITLIST_OFFER_MINUTES=15`
- Test command runs.

## Checkpoint 2 — Shared Infrastructure

Goal:
- Add auth placeholder middleware.
- Add tenant enforcement middleware.
- Add zod validation middleware.
- Add transaction helper.
- Add ID/date/time utilities.

Files:

```txt
src/middleware/auth.js
src/middleware/tenant.js
src/middleware/validate.js
src/utils/transactions.js
src/utils/timezone.js
src/utils/ids.js
src/utils/slot.utils.js
```

Prompt:

```txt
Implement Checkpoint 2. Add auth middleware that extracts actor and clinicId from a dev/test header or JWT placeholder, tenant middleware that attaches req.clinicId and rejects missing clinic context, zod validation middleware, MongoDB transaction helper, and timezone/time-window utilities. Keep behavior aligned with docs/ApiContracts.md.
```

Acceptance:
- Every protected route can require `req.clinicId`.
- Transaction helper supports passing Mongoose session.
- Time validation accepts only `HH:MM`.
- IANA timezone validation uses Luxon.

## Checkpoint 3 — Mongoose Models and Indexes

Goal:
- Implement all schemas from `docs/DataModel.md`.
- Define all indexes in schema files.
- Add setup-indexes script.

Files:

```txt
src/models/Clinic.js
src/models/Doctor.js
src/models/AppointmentType.js
src/models/AvailabilityTemplate.js
src/models/AvailabilityException.js
src/models/Appointment.js
src/models/SlotReservation.js
src/models/AppointmentEvent.js
src/models/WaitlistEntry.js
src/models/SlotOffer.js
scripts/setup-indexes.js
tests/indexes.test.js
```

Prompt:

```txt
Implement Checkpoint 3. Create Mongoose models and indexes exactly from docs/DataModel.md. Include clinicId on all tenant-owned documents. Add setup-indexes script and tests that verify key indexes exist, especially slotReservations partial unique index and slotOffers partial unique index.
```

Acceptance:
- Partial unique active reservation index exists:
  `{ clinicId: 1, doctorId: 1, slotStart: 1 }` with active statuses `held`, `confirmed`.
- `availabilityExceptions` unique index exists.
- `slotOffers` unique active offer index exists.
- Appointment idempotency index is `{ clinicId, idempotencyKey }`.

## Checkpoint 4 — Validators

Goal:
- Implement zod schemas for all API requests.

Files:

```txt
src/validators/clinic.validator.js
src/validators/doctor.validator.js
src/validators/appointmentType.validator.js
src/validators/availability.validator.js
src/validators/slot.validator.js
src/validators/appointment.validator.js
src/validators/waitlist.validator.js
tests/validators.test.js
```

Prompt:

```txt
Implement Checkpoint 4. Add zod validators for clinics, doctors, appointment types, availability templates, exceptions, slot queries, appointments, and waitlist endpoints. Use docs/ApiContracts.md validation rules exactly.
```

Acceptance:
- Bad time formats are rejected.
- Bad day keys are rejected.
- Overlapping windows are rejected.
- Slot range above 30 days rejected.
- Availability validation range above 90 days rejected.
- Appointment duration constraints enforced.

## Checkpoint 5 — Seed Script

Goal:
- Create reproducible seed data.

Files:

```txt
scripts/seed.js
tests/seed.test.js
```

Prompt:

```txt
Implement Checkpoint 5. Add a seed script that creates the exact seed data required by docs/Task.md and docs/TestingPlan.md. It must create 2 clinics, 3 doctors per clinic, appointment types, weekly templates, exceptions, sample confirmed appointments/reservations, and waitlist entries.
```

Acceptance:
- 2 clinics: `Asia/Kolkata`, `Europe/London`.
- 6 total doctors.
- 2-3 appointment types per clinic.
- Templates for all doctors.
- At least block and override exceptions.
- Confirmed appointments have confirmed slotReservations.
- Seed can be rerun safely by clearing/reseeding or using deterministic IDs.

## Checkpoint 6 — Pure Slot Engine

Goal:
- Implement slot computation without DB calls.

Files:

```txt
src/services/slot.engine.js
src/utils/slot.utils.js
tests/slot.engine.test.js
```

Prompt:

```txt
Implement Checkpoint 6 only. Build the pure slot engine from docs/Task.md section 6 and docs/TestingPlan.md. It must accept template, exceptions, timezone, duration, date range, reservations, and now. It must return available slots. No database calls inside.
```

Acceptance:
- Template slots generated.
- Block/override/additional exceptions work.
- Active reservations block by overlap.
- Expired held reservations do not block.
- Past slots filtered.
- DST conversion uses Luxon.
- Last partial slot dropped.

## Checkpoint 7 — Core CRUD Routes

Goal:
- Implement clinics, doctors, appointment types, availability template, exceptions.

Files:

```txt
src/routes/clinic.routes.js
src/routes/doctor.routes.js
src/routes/appointmentType.routes.js
src/routes/availability.routes.js
src/controllers/*.js
src/services/clinic.service.js
src/services/doctor.service.js
src/services/appointmentType.service.js
src/services/availability.service.js
tests/core-routes.test.js
```

Prompt:

```txt
Implement Checkpoint 7. Add CRUD routes for clinics, doctors, appointment types, availability templates, and availability exceptions according to docs/ApiContracts.md. Enforce tenant boundaries in every service query.
```

Acceptance:
- Cross-clinic doctor/type usage rejected.
- Availability exceptions stored separately.
- PUT template preserves exceptions.
- GET availability returns template plus future exceptions.

## Checkpoint 8 — `GET /slots`

Goal:
- Wire pure slot engine to DB.

Files:

```txt
src/routes/slot.routes.js
src/controllers/slot.controller.js
src/services/slot.service.js
tests/slots.api.test.js
```

Prompt:

```txt
Implement Checkpoint 8. Add GET /slots using the pure slot engine. Fetch active availability template, date-range exceptions, appointment type, doctor support, and active slotReservations. Enforce 30-day max range and tenant isolation.
```

Acceptance:
- Query uses `availabilityTemplates`, `availabilityExceptions`, `slotReservations`.
- Does not query a slots collection.
- Excludes confirmed reservations.
- Excludes active held reservations.
- Ignores expired held reservations.
- Uses projection for reservation fields.

## Checkpoint 9 — Event Service

Goal:
- Add immutable event writer and history endpoint.

Files:

```txt
src/services/event.service.js
src/routes/appointment.routes.js
src/controllers/appointment.controller.js
tests/events.test.js
```

Prompt:

```txt
Implement Checkpoint 9. Add event.service.js and GET /appointments/:id/history. Events must be append-only and written with a provided MongoDB session. Do not use Mongoose hooks. Add tests for event order and tenant isolation.
```

Acceptance:
- Events sorted ascending.
- No update/delete event service exists.
- Event writer accepts session.
- Cross-clinic history access does not leak data.

## Checkpoint 10 — Booking: `POST /appointments`

Goal:
- Implement pending appointment creation and held reservation claim.

Files:

```txt
src/services/booking.service.js
src/controllers/appointment.controller.js
tests/booking.test.js
tests/booking.concurrency.test.js
```

Prompt:

```txt
Implement Checkpoint 10. Add POST /appointments using slotReservations as the concurrency lock. Validate requested slot is generated by the slot engine, insert held reservation, insert pending appointment, and write created event in one MongoDB transaction. Handle duplicate key as 409. Implement lazy expiry for expired held reservations and retry once.
```

Acceptance:
- Valid booking creates reservation, appointment, event.
- Duplicate slot returns 409.
- Idempotency works.
- Expired hold is lazily marked expired with event.
- No orphan reservation if appointment/event write fails.
- 20 parallel requests to same slot produce exactly one success.

## Checkpoint 11 — Confirm, Cancel, Reschedule

Goal:
- Implement state transitions.

Files:

```txt
src/services/booking.service.js
src/services/appointment.service.js
tests/appointment-transitions.test.js
tests/appointment-transitions.concurrency.test.js
```

Prompt:

```txt
Implement Checkpoint 11. Add confirm, cancel, and reschedule endpoints. Every mutation must update appointment/reservation and write event in one transaction. Reschedule must keep the same appointment id and swap reservations.
```

Acceptance:
- Confirm: pending + held to confirmed.
- Cancel: appointment cancelled + reservation released.
- Reschedule: same appointment ID, old reservation released, new reservation active.
- Confirm expired hold returns 410.
- Concurrent confirm/cancel produces one success.
- New slot conflict during reschedule leaves old appointment unchanged.

## Checkpoint 12 — Complete and No-Show

Goal:
- Add staff-only terminal visit outcomes.

Prompt:

```txt
Implement Checkpoint 12. Add PATCH /appointments/:id/noshow and PATCH /appointments/:id/complete. Staff only, confirmed only, currentSlotStart must be in the past, and each mutation writes an event in the same transaction.
```

Acceptance:
- Future appointment rejected.
- Patient role rejected.
- Cancelled appointment rejected.
- Events written.

## Checkpoint 13 — Appointment List

Goal:
- Staff dashboard listing.

Prompt:

```txt
Implement Checkpoint 13. Add GET /clinics/:id/appointments with filters and cursor pagination. Reject unbounded queries. Maximum date range 90 days and limit 100.
```

Acceptance:
- Requires date/from-to/patientId.
- Uses clinic filter.
- Uses cursor pagination.
- No offset pagination.

## Checkpoint 14 — Availability Validate

Goal:
- Dry-run proposed schedule changes.

Prompt:

```txt
Implement Checkpoint 14. Add POST /doctors/:id/availability/validate. It must compute proposed windows, query confirmed appointments by currentSlotStart, and return appointments whose currentSlotStart/currentSlotEnd no longer fit. Do not apply changes.
```

Acceptance:
- Range required.
- Range max 90 days.
- Zero conflicts returns 200.
- Conflicts include appointment id, slot, patient, appointment type.

## Checkpoint 15 — Waitlist

Goal:
- Implement waitlist entries and slot offers.

Files:

```txt
src/routes/waitlist.routes.js
src/controllers/waitlist.controller.js
src/services/waitlist.service.js
tests/waitlist.test.js
tests/waitlist.concurrency.test.js
```

Prompt:

```txt
Implement Checkpoint 15. Add waitlist endpoints and slotOffers. Ordering is urgency first then joinedAt. Cancellation should create exactly one active offer using slotOffers partial unique index. Acceptance uses the same reservation booking mechanism and updates offer/waitlist/appointment in one transaction.
```

Acceptance:
- Cannot join if slots are available.
- Duplicate waitlist entry rejected.
- Offer ordering correct.
- Concurrent offer creation produces one active offer.
- Expired offer returns 410 and advances queue.

## Checkpoint 16 — Full Regression and Cleanup

Goal:
- Run everything and tighten docs.

Prompt:

```txt
Run the full test suite and compare implementation against docs/Task.md, docs/DataModel.md, docs/ApiContracts.md, and docs/TestingPlan.md. Fix mismatches. Then update README with setup, run, architecture, data model, concurrency, tenancy, and NoSQL tradeoff sections.
```

Acceptance:
- Full test suite passes.
- README exists.
- Docker command works.
- Seed works.
- Double-booking demo instructions exist.
- No undocumented collections.
- No pre-materialized slots.
- OpenAPI spec at `openapi/openapi.yaml` served at `/api-docs`.
- Postman collection at `postman/ClinicOS.postman_collection.json` with E2E flow.

## Final Manual Demo Checklist

Before showing anyone:

1. Run Docker.
2. Run setup indexes.
3. Run seed.
4. Call `/health`.
5. Call `/slots` for a seeded doctor.
6. Book a slot.
7. Confirm it.
8. Fetch history.
9. Fire two or more concurrent booking requests to same slot.
10. Confirm exactly one succeeds.
11. Cancel an appointment and verify reservation released.
12. Reschedule and verify same appointment ID.
13. Test cross-clinic access rejection.
14. Open Swagger UI at `/api-docs` and run Postman **08 E2E Flow** folder.

