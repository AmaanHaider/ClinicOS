# Clinic Scheduling Engine — Testing Plan

This file defines the tests Cursor should implement while building the project. It maps directly to `docs/Task.md`, `docs/DataModel.md`, and `docs/ApiContracts.md`.

## Testing Stack

Recommended:
- Vitest or Jest
- Supertest for HTTP endpoints
- mongodb-memory-server only if it can run replica set transactions reliably
- Prefer Docker MongoDB replica set for integration and concurrency tests

Do not fake the unique index or transaction behavior in core booking tests. The most important correctness properties must be tested against MongoDB.

## Test Categories

1. Unit tests for pure slot engine.
2. Unit tests for validation helpers.
3. Integration tests for models and indexes.
4. API tests for endpoint behavior.
5. Transaction tests for appointment/event consistency.
6. Concurrency tests for double-booking.
7. Multi-tenancy isolation tests.
8. Waitlist race tests.

## Slot Engine Unit Tests

The slot engine must be a pure function. It receives:
- availability template
- date-specific exceptions for range
- clinic timezone
- appointment type duration
- from/to range
- active reservations
- `now`

It returns available slots.

### Required Cases

#### Weekly template generates slots

Given:
- Monday window `09:00-10:00`
- duration `15`
- no exceptions
- no reservations

Expect:
- `09:00`
- `09:15`
- `09:30`
- `09:45`

#### Last partial slot is dropped

Given:
- window `09:00-10:10`
- duration `30`

Expect:
- `09:00`
- `09:30`
- no `10:00` because it would end at `10:30`

#### Block exception removes all slots

Given:
- template has Monday availability
- exception `{ type: "block", date }`

Expect:
- no slots for that date

#### Override exception replaces template

Given:
- template `09:00-17:00`
- override `10:00-14:00`

Expect:
- slots only inside `10:00-14:00`

#### Additional exception adds windows

Given:
- template `09:00-12:00`
- additional `18:00-20:00`

Expect:
- slots from both windows

#### Additional on normally closed day

Given:
- Sunday template empty
- additional Sunday `10:00-12:00`

Expect:
- Sunday slots generated

#### Overlap check blocks candidate slots

Given:
- querying 15-minute consult slots
- active reservation `09:00-09:30`

Expect:
- `09:00` blocked
- `09:15` blocked
- `09:30` available if within window

#### Held reservation after expiry does not block slot query

Given:
- held reservation with `holdExpiresAt < now`

Expect:
- slot appears available

#### Held reservation before expiry blocks slot query

Given:
- held reservation with `holdExpiresAt > now`

Expect:
- overlapping slots blocked

#### Confirmed reservation blocks slot query

Given:
- confirmed reservation

Expect:
- overlapping slots blocked

#### Past slots filtered

Given:
- date is today
- some generated slots before `now`

Expect:
- only future slots returned

#### DST conversion uses timezone library

Given:
- Europe/London clinic
- date near DST transition

Expect:
- local start/end converted with Luxon using full date context
- no manual fixed offset arithmetic

## Validation Tests

### Time window validation

Must reject:
- `9:00`
- `09:00:00`
- `9am`
- start after end
- start equal end
- overlapping windows
- windows shorter than shortest appointment type

Must accept:
- `09:00`
- `23:55`
- multiple non-overlapping windows

### Date validation

Must reject:
- invalid date strings
- past dates for new exceptions
- `to <= from`
- slot query ranges over 30 days
- availability validate ranges over 90 days

### Tenant validation

Must reject:
- body clinicId trying to override token clinicId
- URL clinicId that does not match token clinicId
- doctor ID from another clinic
- appointment type ID from another clinic

## Model and Index Tests

### Index creation

Verify indexes exist for:
- `availabilityTemplates`: active template unique by clinic/doctor
- `availabilityExceptions`: unique by clinic/doctor/date
- `appointments`: doctor/status/currentSlotStart, clinic/status/currentSlotStart, patient history, idempotency
- `slotReservations`: partial unique active reservation index, conflict query index, expiry lookup
- `appointmentEvents`: appointment history and clinic audit
- `waitlistEntries`: ordered queue and duplicate patient prevention
- `slotOffers`: one active offer per slot

### Partial unique reservation index

Given:
- one `held` reservation for clinic/doctor/slot

Expect:
- second `held` reservation same clinic/doctor/slot fails with duplicate key
- second `confirmed` reservation same clinic/doctor/slot fails with duplicate key
- `released` reservation same clinic/doctor/slot allowed
- `expired` reservation same clinic/doctor/slot allowed
- same doctor/slot in different clinic allowed only if doctor IDs collide by mistake, because clinicId is part of key

### Idempotency index

Given:
- appointment with `{ clinicId, idempotencyKey }`

Expect:
- retry with same key returns original appointment
- duplicate key in same clinic rejected if attempted directly
- same idempotencyKey in different clinic does not collide

## API Integration Tests

### `POST /clinics`

Test:
- valid clinic creates 201
- missing timezone returns 400
- invalid timezone returns 400
- duplicate clinic name allowed

### Doctors

Test:
- create doctor with valid same-clinic appointment types
- reject cross-clinic appointment type
- list defaults to active doctors
- clinic URL mismatch returns 403

### Appointment types

Test:
- create valid type
- reject duration 0
- reject negative duration
- reject duration above 480
- inactive type does not cancel existing appointments

### Availability

Test:
- put weekly template
- reject invalid day keys
- reject overlapping windows
- reject bad time format
- get availability returns template plus future exceptions
- no template returns empty template
- create block exception
- create override exception
- create additional exception
- upsert exception by clinic/doctor/date
- delete exception document

### Availability validate

Test:
- proposed schedule that still covers appointments returns zero conflicts
- proposed schedule that removes appointment window returns conflicts
- unbounded request rejected
- range above 90 days rejected

### `GET /slots`

Test:
- normal 30-day query succeeds
- range above 30 days returns 400
- unsupported appointment type returns empty slots and message
- no template returns empty slots
- block exception returns no slots for date
- override and additional exceptions work
- confirmed reservations removed
- active held reservations removed
- expired held reservations ignored
- past slots ignored
- response includes UTC start/end and local start

## Booking and Transaction Tests

### `POST /appointments`

Test:
- valid request creates held reservation, pending appointment, created event
- all three writes commit together
- invalid doctor clinic rejected
- invalid appointment type clinic rejected
- unsupported appointment type rejected
- slot in past rejected
- slot outside availability rejected
- slot crossing window end rejected
- arbitrary overlapping slot not generated by slot engine rejected
- idempotent retry returns original appointment
- duplicate active slot returns 409

### Expired hold lazy release

Given:
- held reservation with `holdExpiresAt < now`
- linked pending appointment

When:
- new booking attempts same slot

Expect:
- old reservation becomes `expired`
- old appointment becomes `expired`
- expired event written
- new reservation and appointment created
- retry happens once only

### Confirm

Test:
- pending appointment confirms successfully
- linked reservation becomes confirmed
- confirmed event written
- transaction commits all changes
- expired hold returns 410
- double confirm returns one success and one 409
- schedule changed between hold and confirm causes release/cancel event path

### Cancel

Test:
- pending appointment can cancel
- confirmed appointment can cancel
- linked reservation becomes released
- cancelled event written
- cancelling cancelled appointment rejected
- concurrent cancels produce one success

### Reschedule

Test:
- confirmed appointment reschedules to new slot
- appointment ID remains same
- new reservation created
- old reservation released
- appointment currentReservationId/currentSlotStart/currentSlotEnd updated
- rescheduled event records previous and new slot
- new slot conflict returns 409 and old appointment remains unchanged
- pending appointment reschedule allowed
- cancelled/completed appointment reschedule rejected
- transaction rollback leaves no partial reservation if event write fails

### No-show and complete

Test:
- staff can mark past confirmed appointment no-show
- staff can mark past confirmed appointment complete
- future appointment cannot be no-show or completed
- patient cannot mark no-show/complete
- cancelled appointment cannot become no-show/complete

### History

Test:
- history returns events ordered ascending
- cross-clinic appointment history returns 404 or forbidden according to route policy
- appointment with no events returns empty array and logs alert

## Concurrency Tests

These are mandatory.

### Double booking same slot

Setup:
- one clinic
- one doctor
- one appointment type
- one available generated slot

Action:
- fire 20 parallel `POST /appointments` requests to the same slot with different idempotency keys

Expect:
- exactly one returns 201
- 19 return 409
- exactly one active reservation exists for that clinic/doctor/slot
- exactly one pending appointment exists for that slot
- exactly one created event exists for winning appointment

Repeat with 100 parallel requests if local machine can handle it.

### Concurrent booking after expired hold

Setup:
- expired held reservation blocks unique index

Action:
- fire multiple parallel booking attempts for same slot

Expect:
- old hold expired once
- exactly one new booking succeeds
- losers return 409
- no duplicate expired events

### Concurrent confirm

Action:
- fire two `PATCH /appointments/:id/confirm` requests at once

Expect:
- one succeeds
- one returns 409
- one confirmed event
- reservation confirmed once

### Concurrent cancel

Action:
- fire two deletes at once

Expect:
- one succeeds
- one returns 409
- reservation released once
- one cancelled event

### Concurrent reschedule to same target slot

Action:
- two different appointments attempt to reschedule into same target slot

Expect:
- one succeeds
- one returns 409
- target slot has one active reservation
- losing appointment remains unchanged

## Multi-Tenancy Tests

Test every collection with tenant boundaries.

Required:
- clinic A cannot fetch clinic B doctors
- clinic A cannot use clinic B appointment type
- clinic A cannot book clinic B doctor
- clinic A cannot fetch clinic B appointment
- clinic A cannot fetch clinic B appointment history
- clinic A cannot mutate clinic B availability
- clinic A cannot see clinic B waitlist
- all list routes include clinic filter
- all service queries include `clinicId`

Add a test helper that creates two clinics with intentionally similar data. If IDs are generated manually in tests, include one collision-like case where possible to prove clinicId is part of query and index paths.

## Waitlist Tests

### Join waitlist

Test:
- cannot join if direct slot available
- can join if no slots available
- duplicate patient/date/type rejected
- urgency flag affects ordering

### Offer creation

When cancellation opens slot:
- top urgent patient receives offer first
- if no urgent patients, earliest joined receives offer
- exactly one `slotOffers` document with status `offered` exists per opened slot

### Concurrent cancellations

Action:
- trigger two cancellation flows that try to offer same slot or same waitlist queue

Expect:
- unique `slotOffers` index prevents duplicate active offers
- exactly one patient receives active offer

### Offer acceptance

Test:
- offered patient can accept before expiry
- offer becomes accepted
- waitlist entry becomes accepted
- appointment/reservation created
- expired offer returns 410 and advances queue
- slot re-taken before accept returns 409 and marks offer superseded

## Seed Script Verification

The seed script must create:
- 2 clinics
- one clinic in `Asia/Kolkata`
- one clinic in `Europe/London`
- 3 doctors per clinic
- 2-3 appointment types per clinic
- weekly templates for each doctor
- at least 30 days of queryable availability
- 2 sample exceptions per doctor, one block and one override
- sample confirmed appointments
- sample waitlist entries

Add a smoke test that runs seed and verifies:
- counts match
- indexes exist
- `/slots` returns meaningful output for at least one seeded doctor

## Non-Functional Tests

### Performance smoke

With seeded data:
- 30-day `/slots` query should complete within an acceptable local threshold.
- Query should project only needed reservation fields: `slotStart`, `slotEnd`, `status`, `holdExpiresAt`.

### Audit integrity

For every appointment mutation endpoint:
- event count increases by one
- final event newState matches appointment status
- if mutation fails, event is not written
- if event write fails inside transaction, appointment mutation rolls back

### No pre-materialised slots

Test or code review check:
- no `slots` collection exists
- no script generates future slots
- slot availability is computed from template + exceptions + reservations

