# Clinic Scheduling Engine — API Contracts

This file turns the endpoint section of `docs/Task.md` into implementation-ready contracts. If there is a conflict, `docs/Task.md` is the source of truth.

## Interactive API docs

| Format | Location |
|--------|----------|
| Swagger UI (running server) | `GET /api-docs` |
| OpenAPI JSON | `GET /api-docs/openapi.json` |
| OpenAPI YAML (source) | `openapi/openapi.yaml` |

## Postman

Optional: `postman/ClinicOS.postman_collection.json` (not required; use `npm run e2e:curl` for manual E2E).

## Auth layer status

- Protected routes require JWT Bearer tokens.
- Credential endpoints are available: `POST /auth/signup`, `POST /auth/login`.
- `npm run mint-jwt` remains available as a developer utility for manual testing and scripts.

## Global API Rules

- All tenant-owned endpoints are scoped by authenticated `clinicId`.
- `clinicId` from the request body is never trusted.
- If a URL contains `clinicId`, it must match the authenticated token clinic.
- Validation failures return `400`.
- Cross-tenant access returns `403` when the user is operating on a clinic route, and `404` when revealing document existence would leak data.
- Booking conflicts return `409`.
- Expired holds return `410`.
- Unbounded list queries are rejected.
- Datetimes are UTC ISO 8601 unless explicitly named `Local`.
- Dates are `YYYY-MM-DD`.
- Time windows use `HH:MM` 24-hour local clinic time.

## Error Shape

Use one consistent error shape:

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "This slot has just been taken. Please select another.",
    "details": {}
  }
}
```

Standard HTTP error codes returned by the API:

| Code | HTTP | Typical use |
|------|------|-------------|
| `BAD_REQUEST` | 400 | Validation, business rule rejection |
| `UNAUTHORIZED` | 401 | Missing or invalid JWT |
| `FORBIDDEN` | 403 | Clinic mismatch, ownership |
| `NOT_FOUND` | 404 | Missing resource |
| `CONFLICT` | 409 | Slot taken, duplicate waitlist, version conflict |
| `GONE` | 410 | Expired hold or waitlist offer |
| `DUPLICATE_KEY` | 409 | Unhandled Mongo duplicate key (middleware fallback) |
| `INTERNAL_SERVER_ERROR` | 500 | Unexpected server error |

## Auth Endpoints

### `POST /auth/signup`

Purpose: create a clinic-scoped user account for login.

Request:

```json
{
  "clinicId": "clinic_01HX...",
  "email": "admin@clinic.example",
  "password": "StrongPass123!",
  "name": "Clinic Admin",
  "role": "clinic_staff"
}
```

Rules:
- `clinicId` must exist.
- `email` unique per clinic.
- Password must be hashed before storage.
- Returns user identity and access token.

### `POST /auth/login`

Purpose: exchange clinic-scoped credentials for JWT.

Request:

```json
{
  "clinicId": "clinic_01HX...",
  "email": "admin@clinic.example",
  "password": "StrongPass123!"
}
```

Success:

```json
{
  "accessToken": "eyJ...",
  "user": {
    "_id": "user_01HX...",
    "clinicId": "clinic_01HX...",
    "role": "clinic_staff",
    "name": "Clinic Admin"
  }
}
```

### `POST /auth/refresh` (future)

Purpose: issue a new access token from a valid refresh session.

## Clinics

### `POST /clinics`

Purpose: create tenant root.

Request:

```json
{
  "name": "Sharma Medical Centre",
  "timezone": "Asia/Kolkata",
  "address": {
    "line1": "42 MG Road",
    "city": "Bengaluru",
    "state": "Karnataka",
    "pincode": "560001"
  },
  "contactEmail": "admin@sharmamedical.in",
  "contactPhone": "+91-80-12345678"
}
```

Validation:
- `timezone` is required.
- `timezone` must be valid IANA timezone via Luxon `IANAZone.isValidZone()`.
- Reject strings like `IST` or `GMT+5:30`.
- `contactEmail` must be valid email if provided.
- Duplicate clinic names are allowed.

Success: `201`

```json
{
  "_id": "clinic_01HX4K2M...",
  "name": "Sharma Medical Centre",
  "timezone": "Asia/Kolkata",
  "isActive": true,
  "createdAt": "2025-06-01T06:30:00Z",
  "updatedAt": "2025-06-01T06:30:00Z"
}
```

## Doctors

### `POST /clinics/:clinicId/doctors`

Purpose: create doctor scoped to clinic.

Request:

```json
{
  "name": "Dr. Priya Sharma",
  "specialisation": "General Physician",
  "email": "priya.sharma@sharmamedical.in",
  "supportedAppointmentTypes": ["appttype_01HX..."]
}
```

Validation:
- URL `clinicId` must match authenticated clinic.
- Every `supportedAppointmentTypes` ID must belong to the same clinic.
- Empty `supportedAppointmentTypes` is allowed.
- Same person working at two clinics is modelled as two doctor documents.

Success: `201`

### `GET /clinics/:clinicId/doctors`

Query params:
- `isActive`, boolean, default `true`
- `appointmentType`
- `page`
- `limit`

Rules:
- Enforce `clinicId` from token.
- Default excludes inactive doctors.
- No doctors returns `200` with empty array.
- URL clinic mismatch returns `403`.

Success: `200`

```json
{
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 20,
    "hasMore": false
  }
}
```

## Appointment Types

### `POST /clinics/:id/appointment-types`

Request:

```json
{
  "name": "General Consult",
  "durationMinutes": 15,
  "color": "#4A90E2",
  "requiresSpecialisation": null
}
```

Validation:
- `durationMinutes` must be a positive integer.
- Recommended multiple of 5.
- Reject duration greater than 480 minutes.
- Appointment type belongs to authenticated clinic.

Success: `201`

### `GET /clinics/:id/appointment-types`

Query params:
- `includeInactive`, boolean, default `false`

Rules:
- Default only active appointment types.

Success: `200`

### `PATCH /appointment-types/:id`

Allowed changes:
- `name`
- `durationMinutes`
- `color`
- `requiresSpecialisation`
- `isActive`

Rules:
- Verify type belongs to caller clinic.
- Changing duration does not modify existing appointments.
- Setting inactive prevents new bookings but does not cancel existing appointments.

## Availability

### `PUT /doctors/:id/availability`

Purpose: full replace of weekly template. Exceptions are preserved separately.

Request:

```json
{
  "weeklyTemplate": {
    "MON": [
      { "start": "09:00", "end": "13:00" },
      { "start": "15:00", "end": "18:00" }
    ],
    "TUE": [{ "start": "10:00", "end": "17:00" }],
    "WED": [{ "start": "09:00", "end": "13:00" }],
    "THU": [{ "start": "10:00", "end": "17:00" }],
    "FRI": [{ "start": "09:00", "end": "18:00" }],
    "SAT": [],
    "SUN": []
  }
}
```

Validation:
- Day keys must be `MON`, `TUE`, `WED`, `THU`, `FRI`, `SAT`, `SUN`.
- Time format must be `HH:MM`.
- `start` must be before `end`.
- No overlapping windows on same day.
- No window shorter than the clinic's shortest appointment type duration.
- Times are local strings and are not converted to UTC when stored.

Rules:
- Upsert active template by `{ clinicId, doctorId, isActive: true }`.
- Existing confirmed appointments are not cancelled or invalidated.
- Doctor should call `/availability/validate` before applying risky changes.

### `GET /doctors/:id/availability`

Purpose: return current template plus future exceptions.

Success:

```json
{
  "doctorId": "dr_01HX...",
  "weeklyTemplate": {},
  "exceptions": [
    {
      "date": "2025-06-10",
      "type": "block",
      "reason": "Conference"
    }
  ]
}
```

Rules:
- No template returns `200` with empty template.
- Return only future exceptions by default.

### `POST /doctors/:id/exceptions`

Purpose: add or replace one date-specific exception.

Block request:

```json
{
  "date": "2025-06-10",
  "type": "block",
  "reason": "Conference"
}
```

Override request:

```json
{
  "date": "2025-06-11",
  "type": "override",
  "windows": [{ "start": "10:00", "end": "14:00" }],
  "reason": "Half day"
}
```

Additional request:

```json
{
  "date": "2025-06-12",
  "type": "additional",
  "windows": [{ "start": "19:00", "end": "21:00" }],
  "reason": "Evening clinic"
}
```

Validation:
- Date must be `YYYY-MM-DD`.
- Date cannot be in the past.
- `block` must not include windows.
- `override` and `additional` must include at least one valid window.
- Windows follow template validation rules.

Rules:
- Upsert by `{ clinicId, doctorId, date }`.
- Second POST for same date replaces first.
- Does not cancel existing appointments.

### `DELETE /doctors/:id/exceptions/:date`

Purpose: remove exception document and revert that date to template.

Rules:
- Verify doctor and exception belong to caller clinic.
- Deleting past exception is allowed.
- Non-existent exception returns `404`.
- Existing appointments remain.

### `POST /doctors/:id/availability/validate`

Purpose: dry-run proposed schedule change.

Request:

```json
{
  "proposedTemplate": {},
  "dateRange": {
    "from": "2025-06-10",
    "to": "2025-07-10"
  }
}
```

Rules:
- Does not apply change.
- Range required.
- Maximum range 90 days.
- Query confirmed appointments by `currentSlotStart`.
- Conflict if `currentSlotStart` and `currentSlotEnd` do not fit inside proposed schedule windows.

Success:

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

Zero conflicts returns `200` with `conflictCount: 0`.

## Slots

### `GET /slots`

Query params:
- `doctorId`, required
- `clinicId`, required
- `appointmentType`, required
- `from`, required date
- `to`, required date

Rules:
1. Validate query params.
2. Validate `clinicId` matches authenticated clinic and doctor clinic.
3. Fetch active availability template.
4. Fetch date-range exceptions.
5. Fetch appointment type and duration.
6. Verify doctor supports appointment type.
7. Fetch active reservations for range:
   - `status: confirmed`
   - OR `status: held` and `holdExpiresAt > now`
8. Resolve effective windows by date.
9. Convert local windows to UTC using clinic timezone.
10. Generate candidate slots by duration.
11. Filter by reservation overlap.
12. Filter past slots.

Constraints:
- Maximum query range 30 days.
- `to` must be after `from`.
- `from` may not be more than one year in the past.
- No template returns empty slots.
- Unsupported appointment type returns empty slots and message.
- Expired held reservations are excluded from availability.

Success:

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

## Appointments

### `POST /appointments`

Purpose: create pending appointment and held reservation.

Request:

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

Rules:
1. Validate `slotStart` is future UTC ISO datetime.
2. Verify doctor belongs to caller clinic.
3. Verify appointment type belongs to caller clinic and doctor supports it.
4. Compute `slotEnd`.
5. Verify slot fits effective windows for that date.
6. Verify `slotStart` exactly matches a generated candidate slot.
7. Check idempotency key. If existing, return existing appointment with `200`.
8. In a MongoDB transaction:
   - insert `held` slot reservation
   - insert `pending` appointment
   - write `created` event
9. If unique reservation insert fails with `11000`, check if blocker is expired.
10. If blocker is expired, transactionally mark reservation and appointment `expired`, write `expired` event, retry once.
11. Otherwise return `409 CONFLICT`.

Success: `201`

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

Conflict: `409`

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "This slot has just been taken. Please select another."
  }
}
```

### `PATCH /appointments/:id/confirm`

Purpose: transition pending appointment and held reservation to confirmed.

Rules:
1. Fetch appointment and verify clinic.
2. Fetch linked reservation and verify `held` and `holdExpiresAt > now`.
3. Re-validate slot still fits doctor schedule.
4. In one transaction:
   - appointment `pending -> confirmed`
   - reservation `held -> confirmed`
   - increment appointment version
   - write `confirmed` event
5. Expired hold returns `410 GONE`.
6. Concurrent confirm returns `409`.

Success: `200`

Expired:

```json
{
  "error": {
    "code": "GONE",
    "message": "Your booking hold has expired. Please start again."
  }
}
```

### `PATCH /appointments/:id`

Purpose: reschedule while keeping same appointment ID.

Request:

```json
{
  "newSlotStart": "2025-06-16T04:00:00Z",
  "reason": "Patient requested change"
}
```

Rules:
1. Fetch current appointment and verify clinic.
2. Status must be `confirmed` or `pending`.
3. Validate new slot like new booking.
4. Reject no-op if same as `currentSlotStart`.
5. Claim new reservation with same unique reservation mechanism.
6. In one transaction:
   - create new reservation
   - mark old reservation `released`
   - update appointment `currentReservationId`, `currentSlotStart`, `currentSlotEnd`
   - increment version
   - write `rescheduled` event
7. If new slot claim fails, return `409` and leave old appointment unchanged.

Success: `200`

### `DELETE /appointments/:id`

Purpose: cancel appointment and release reservation.

Request:

```json
{
  "cancelledBy": "patient",
  "reason": "Personal emergency"
}
```

Rules:
1. Fetch appointment and verify clinic.
2. Status must be `pending` or `confirmed`.
3. In one transaction:
   - appointment status `cancelled`
   - linked active reservation `released`
   - increment version
   - write `cancelled` event
4. Trigger waitlist offer flow if applicable.

Success: `200`

### `PATCH /appointments/:id/noshow`

Rules:
- Clinic staff only.
- Appointment must be `confirmed`.
- `currentSlotStart < now`.
- Update to `no_show`.
- Write event transactionally.

### `PATCH /appointments/:id/complete`

Rules:
- Clinic staff only.
- Appointment must be `confirmed`.
- `currentSlotStart < now`.
- Update to `completed`.
- Write event transactionally.

### `GET /appointments/:id`

Rules:
- Fetch by ID.
- Verify `clinicId`.
- Cross-clinic document returns `404`.

### `GET /appointments/:id/history`

Rules:
- Verify appointment belongs to caller clinic.
- Fetch `appointmentEvents` by `appointmentId`.
- Sort `timestamp` ascending.

Success:

```json
{
  "appointmentId": "appt_01HX...",
  "events": []
}
```

### `GET /clinics/:id/appointments`

Query params:
- `doctorId`
- `date`
- `status`
- `from`
- `to`
- `patientId`
- `page`
- `limit`
- `after`

Rules:
- Enforce clinic from token.
- Require at least one of `date`, `from/to`, or `patientId`.
- Maximum range 90 days.
- Maximum limit 100.
- Use cursor pagination, not offset pagination.

## Waitlist

### `POST /waitlist`

Purpose: join waitlist for doctor/date/type.

Request:

```json
{
  "doctorId": "dr_01HX...",
  "targetDate": "2025-06-15",
  "appointmentTypeId": "appttype_01HX...",
  "urgencyFlag": false
}
```

Rules:
- Verify no available slots exist. If slots are available, reject with 400 and tell patient to book directly.
- Unique by `{ clinicId, doctorId, targetDate, appointmentTypeId, patientId }`.
- Create with `status: waiting`, `joinedAt: now`.

### `POST /waitlist/:id/accept`

Rules:
1. Fetch waitlist entry.
2. Verify status `offered`.
3. Verify linked `slotOffers` document is `offered` and not expired.
4. Attempt booking with same reservation mechanism.
5. In one transaction:
   - create/confirm appointment as appropriate
   - update waitlist entry `accepted`
   - update slot offer `accepted`
6. Expired offer returns `410`.
7. Slot re-taken returns `409`, marks offer `superseded`, and advances queue.

### `GET /doctors/:id/waitlist`

Rules:
- Clinic staff view.
- Query statuses `waiting` and `offered`.
- Sort by `urgencyFlag: -1`, then `joinedAt: 1`.

### `DELETE /waitlist/:id`

Rules:
- Patient can remove their own entry.
- Status must be `waiting` or `offered`.
- Removing offered entry abandons offer and triggers next offer.

