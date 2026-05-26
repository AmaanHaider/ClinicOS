# Clinic Scheduling Engine — Progress Tracker

Use this file as the resume point for Cursor sessions.

`docs/CursorPlan.md` defines the implementation order. This file records what has actually been completed, what is in progress, what tests passed, and where to resume if context is lost.

**Implementation language:** JavaScript (ES modules, `.js` files only). Do not add TypeScript, `tsconfig.json`, or `.ts` source files.

## How To Use This File

At the start of every Cursor session, paste:

```txt
Read docs/Progress.md first, then docs/CursorPlan.md. Continue from the first checkpoint whose status is not Done. Before coding, summarize where we are and what you will implement next.
```

At the end of every checkpoint, Cursor must update this file:

```txt
Update docs/Progress.md with:
- checkpoint status
- files created/changed
- tests added
- tests run and result
- known issues
- exact next checkpoint
```

Do not mark a checkpoint `Done` unless:

- the implementation for that checkpoint is complete
- tests for that checkpoint exist
- tests were run, or the reason they were not run is recorded
- no known blocker remains for that checkpoint

## Status Legend

- `Not Started`
- `In Progress`
- `Blocked`
- `Done`

## Current Resume Point

**Current checkpoint:** `Checkpoint 10 — Booking: POST /appointments` (tests and hardening)

**Current status:** `In Progress` — booking service implemented; integration and concurrency tests missing

**Overall:** ~70–75% feature code in place; ~15–20% of `docs/TestingPlan.md` test coverage

**Next Cursor prompt:**

```txt
Read docs/Progress.md first, then docs/CursorPlan.md.

Continue from Checkpoint 10. Add booking integration tests and booking.concurrency.test.js against Docker Mongo replica set. Then harden booking (overlap check before claim) and wire waitlist offer on cancel (Checkpoint 15 gap).

Run npm test and record results in docs/Progress.md.
```

**Priority order if deviating from strict checkpoint sequence:**

1. Checkpoint 10 — `booking.test.js`, `booking.concurrency.test.js` (Docker Mongo required)
2. Checkpoint 11 — `appointment-transitions.test.js`, concurrency variants
3. Checkpoint 15 — wire `offerNextWaitlistPatient` on cancel; fix accept → confirm flow; queue advance
4. Checkpoint 6 — expand `slot.engine.test.js` (DST, additional, partial slot, expired held)
5. Checkpoint 16 — README, seed smoke test, full regression

## Checkpoint Tracker

| Checkpoint | Name | Status | Notes |
|---|---|---|---|
| 0 | Planning Only | Done | Architecture reviewed; appointments vs slotReservations split confirmed intentional. |
| 1 | Project Scaffold | Done | Express, Vitest, Supertest, Docker Mongo replica set, env, health route. API runs on host (`npm run dev`), not in Compose. |
| 2 | Shared Infrastructure | Done | Auth (dev headers), tenant, validate, transactions, timezone, ids, slot.utils, errors. |
| 3 | Mongoose Models and Indexes | In Progress | All 9 models + schema indexes; `scripts/setup-indexes.js`. Tests are schema-only (`index-definitions.test.js`), not live Mongo sync. |
| 4 | Validators | In Progress | All Zod validators present. No `validators.test.js`. |
| 5 | Seed Script | In Progress | `scripts/seed.js` runs. Missing vs spec: ~10 appointments (has 1), 2 waitlist entries (has 1). No `seed.test.js`. |
| 6 | Pure Slot Engine | In Progress | `slot.engine.js` is pure. Only 3 unit tests; missing DST, additional, last-partial-slot, held-expiry cases. |
| 7 | Core CRUD Routes | In Progress | All clinic/doctor/type/availability routes wired. No `core-routes.test.js`. |
| 8 | GET /slots | In Progress | `slot.service.js` + controller done. No `slots.api.test.js`. Query requires `clinicId` but handler uses token `clinicId`. |
| 9 | Event Service | In Progress | `event.service.js` + history endpoint. No `events.test.js`. |
| 10 | Booking: POST /appointments | In Progress | Full flow: held reservation, pending appointment, created event, idempotency, lazy expiry + one retry. No booking or concurrency tests. No explicit overlap check before insert. |
| 11 | Confirm, Cancel, Reschedule | In Progress | All implemented. Gaps: confirm lacks optimistic `version` filter; cancel does not trigger waitlist offer. No transition tests. |
| 12 | Complete and No-Show | In Progress | `markOutcome` + routes done. No dedicated API tests. |
| 13 | Appointment List | In Progress | Cursor pagination (`after` + `limit`). Missing 90-day range cap on `from`/`to`. No list tests. |
| 14 | Availability Validate | In Progress | Endpoint exists; logic checks weekly template only (ignores exceptions). No tests. |
| 15 | Waitlist | In Progress | Join, accept, list, remove + `offerNextWaitlistPatient` helper. Cancel does not call offer helper. Accept leaves appointment `pending` (no auto-confirm). No queue advance on expired/superseded. No concurrency tests. |
| 16 | Full Regression and Cleanup | Not Started | No README. Only 7 unit tests pass. No double-booking demo docs. |

## Test Summary

Last run: `npm test` — **7 passed** (3 files)

| File | Tests | Type |
|---|---|---|
| `tests/health.test.js` | 1 | HTTP (no DB) |
| `tests/index-definitions.test.js` | 3 | Schema index definitions (no live Mongo) |
| `tests/slot.engine.test.js` | 3 | Pure unit |

**Not present yet:** `validators.test.js`, `seed.test.js`, `core-routes.test.js`, `slots.api.test.js`, `booking.test.js`, `booking.concurrency.test.js`, `appointment-transitions.test.js`, `events.test.js`, `waitlist.test.js`, `waitlist.concurrency.test.js`, multi-tenancy suite.

**Mongo for integration tests:** `docker compose up -d` then `npm run setup:indexes` and `npm run seed`. URI: `mongodb://localhost:27017/clinic_scheduling?replicaSet=rs0`

## Session Log

### Session 0 — Documentation Preparation

Status: `Done`

Completed:

- Created `docs/Task.md`, `docs/CursorPlan.md`, `docs/DataModel.md`, `docs/ApiContracts.md`, `docs/TestingPlan.md`, this file.

Tests run: N/A

### Session 1 — Codebase Implementation (bulk)

Status: `In Progress`

Completed:

- Full JavaScript Express API under `src/` (models, validators, services, controllers, routes).
- Scripts: `scripts/seed.js`, `scripts/setup-indexes.js`, `scripts/init-replica.js`.
- Minimal test suite (health, index definitions, slot engine basics).

Tests run:

```txt
npm install
npm test
# 7 passed (3 files)
```

Known issues (see also per-checkpoint notes):

- `docs/Progress.md` was stale until this session.
- Waitlist offer not triggered on appointment cancel.
- Booking overlap check not enforced beyond exact `slotStart` + slot-engine match.
- No README; Docker Compose is Mongo-only.

Next:

- Checkpoint 10 tests + concurrency, then Checkpoint 11/15 hardening.

## Files Created Or Changed By Checkpoint

### Checkpoint 0 — Planning Only

Files changed: None (docs only).

Tests: None.

Completion notes: Architecture and checkpoint plan confirmed. No contradiction between `appointments` and `slotReservations`.

### Checkpoint 1 — Project Scaffold

Files:

```txt
package.json
.env.example
.gitignore
docker-compose.yml
scripts/init-replica.js
src/app.js
src/server.js
src/config/env.js
src/config/db.js
src/routes/index.js          # includes GET /health
src/middleware/error.js
src/utils/errors.js
tests/health.test.js
```

Tests: `tests/health.test.js` — pass.

Completion notes: Done. Compose runs Mongo replica set only; start API with `npm run dev`.

### Checkpoint 2 — Shared Infrastructure

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

Auth dev headers: `x-clinic-id` (required), `x-actor-id`, `x-actor-role`, `x-actor-name`.

Completion notes: Done.

### Checkpoint 3 — Mongoose Models and Indexes

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
src/models/index.js
scripts/setup-indexes.js
tests/index-definitions.test.js
```

Tests: Schema partial-unique indexes verified in memory — pass. Live `syncIndexes` not asserted in tests.

Completion notes: In Progress until live index integration test or documented manual verify.

### Checkpoint 4 — Validators

Files:

```txt
src/validators/common.js
src/validators/clinic.validator.js
src/validators/doctor.validator.js
src/validators/appointmentType.validator.js
src/validators/availability.validator.js
src/validators/slot.validator.js
src/validators/appointment.validator.js
src/validators/waitlist.validator.js
```

Tests: None.

Completion notes: In Progress — add `tests/validators.test.js`.

### Checkpoint 5 — Seed Script

Files: `scripts/seed.js`

Creates: `clinic_india` (Asia/Kolkata), `clinic_london` (Europe/London), 3 doctors/clinic, 3 types/clinic, weekly templates, block + override exceptions per doctor, 1 confirmed appointment + reservation, 1 waitlist entry.

Tests: None.

Completion notes: In Progress — expand sample data; add `tests/seed.test.js`.

### Checkpoint 6 — Pure Slot Engine

Files:

```txt
src/services/slot.engine.js
src/utils/slot.utils.js
tests/slot.engine.test.js
```

Tests: 3 cases (template, block, overlap) — pass.

Completion notes: In Progress — add remaining `docs/TestingPlan.md` slot engine cases.

### Checkpoint 7 — Core CRUD Routes

Files:

```txt
src/controllers/clinic.controller.js
src/controllers/doctor.controller.js
src/controllers/appointment-type.controller.js
src/controllers/availability.controller.js
src/services/clinic.service.js
src/services/doctor.service.js
src/services/appointment-type.service.js
src/services/availability.service.js
```

Routes: `POST /clinics`, clinic/doctor/type CRUD, availability PUT/GET, exceptions POST/DELETE.

Tests: None.

Completion notes: In Progress — add `tests/core-routes.test.js`.

### Checkpoint 8 — GET /slots

Files: `src/controllers/slot.controller.js`, `src/services/slot.service.js`

Tests: None.

Completion notes: In Progress — add `tests/slots.api.test.js`; validate query `clinicId` matches token.

### Checkpoint 9 — Event Service

Files: `src/services/event.service.js`, history via `appointment.controller.js`

Tests: None.

Completion notes: In Progress — add `tests/events.test.js`.

### Checkpoint 10 — Booking: POST /appointments

Files: `src/services/booking.service.js` (`createAppointment`, `expireBlockingHold`)

Tests: None.

Completion notes: In Progress — add `tests/booking.test.js`, `tests/booking.concurrency.test.js`; add overlap check before reservation insert.

### Checkpoint 11 — Confirm, Cancel, Reschedule

Files: `booking.service.js` — `confirmAppointment`, `cancelAppointment`, `rescheduleAppointment`

Tests: None.

Gaps:

- Cancel does not call `waitlist.service.offerNextWaitlistPatient`.
- Confirm does not use `{ version }` optimistic filter on update.

Completion notes: In Progress — add `tests/appointment-transitions.test.js` and concurrency variants.

### Checkpoint 12 — Complete and No-Show

Files: `booking.service.js` — `markOutcome`; routes `PATCH .../noshow`, `PATCH .../complete`

Tests: None.

Completion notes: In Progress — cover in transition tests.

### Checkpoint 13 — Appointment List

Files: `appointment.controller.js` — `listAppointments`

Tests: None.

Gaps: No 90-day max on `from`/`to` range.

Completion notes: In Progress — add list tests and range validation.

### Checkpoint 14 — Availability Validate

Files: `availability.service.js` — `validateAvailabilityChange`

Tests: None.

Gaps: Does not apply date-specific exceptions to conflict detection.

Completion notes: In Progress — align with spec; add tests.

### Checkpoint 15 — Waitlist

Files:

```txt
src/services/waitlist.service.js
src/controllers/waitlist.controller.js
src/validators/waitlist.validator.js
```

Routes: `POST /waitlist`, `POST /waitlist/:id/accept`, `GET /doctors/:id/waitlist`, `DELETE /waitlist/:id`

Tests: None.

Gaps:

- `offerNextWaitlistPatient` not called from cancel flow.
- Accept uses `createAppointment` (pending) without confirm.
- No expired-offer / superseded / advance-queue logic.

Completion notes: In Progress — wire cancel → offer; fix accept; add `tests/waitlist.test.js` and concurrency tests.

### Checkpoint 16 — Full Regression and Cleanup

Files: None yet (no README).

Tests: Full suite not meeting `docs/TestingPlan.md`.

Completion notes: Not Started.

## Route Inventory (implemented)

All routes in `src/routes/index.js`:

| Method | Path | Auth |
|---|---|---|
| GET | `/health` | No |
| POST | `/clinics` | No |
| POST | `/clinics/:clinicId/doctors` | Yes |
| GET | `/clinics/:clinicId/doctors` | Yes |
| POST | `/clinics/:clinicId/appointment-types` | Yes |
| GET | `/clinics/:clinicId/appointment-types` | Yes |
| PATCH | `/appointment-types/:id` | Yes |
| PUT | `/doctors/:id/availability` | Yes |
| GET | `/doctors/:id/availability` | Yes |
| POST | `/doctors/:id/exceptions` | Yes |
| DELETE | `/doctors/:id/exceptions/:date` | Yes |
| POST | `/doctors/:id/availability/validate` | Yes |
| GET | `/slots` | Yes |
| POST | `/appointments` | Yes |
| PATCH | `/appointments/:id/confirm` | Yes |
| PATCH | `/appointments/:id` | Yes |
| DELETE | `/appointments/:id` | Yes |
| PATCH | `/appointments/:id/noshow` | Yes |
| PATCH | `/appointments/:id/complete` | Yes |
| GET | `/appointments/:id` | Yes |
| GET | `/appointments/:id/history` | Yes |
| GET | `/clinics/:clinicId/appointments` | Yes |
| POST | `/waitlist` | Yes |
| POST | `/waitlist/:id/accept` | Yes |
| GET | `/doctors/:id/waitlist` | Yes |
| DELETE | `/waitlist/:id` | Yes |

## Known Decisions That Must Not Drift

- Do not create a stored/pre-materialised slots collection.
- Do not embed all exceptions inside the weekly template document.
- Do not use appointment documents themselves as the uniqueness lock.
- Do use `slotReservations` for booking concurrency.
- Do include `clinicId` in tenant-owned documents, queries, and hot-path indexes.
- Do keep the same appointment ID on reschedule.
- Do write events inside the same MongoDB transaction as appointment/reservation mutations.
- Do run MongoDB as a replica set.
- Do treat expired holds as auditable state transitions.
- Do keep `slot.engine.js` pure and DB-free.
