#!/usr/bin/env bash
# End-to-end API smoke via curl. Usage: ./scripts/e2e-curl.sh [BASE_URL] [PATIENT_TOKEN]
set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"
PATIENT_TOKEN="${2:-}"
CLINIC="${CLINIC:-clinic_india}"

if [[ -z "$PATIENT_TOKEN" ]]; then
  echo "Usage: $0 [BASE_URL] <PATIENT_JWT>"
  echo "  or:  PATIENT_TOKEN=... $0"
  exit 1
fi

STAFF_TOKEN=$(node -e "
import './src/config/env.js';
import { signToken } from './src/utils/jwt.js';
console.log(signToken({ sub: 'staff_demo', clinicId: '$CLINIC', role: 'clinic_staff', name: 'Staff' }));
" 2>/dev/null || true)

PASS=0
FAIL=0
SKIP=0

run() {
  local name="$1"
  local expect="$2"
  shift 2
  local code
  code=$(curl -s -o /tmp/e2e-body.json -w "%{http_code}" "$@")
  local ok=0
  for e in $expect; do
    [[ "$code" == "$e" ]] && ok=1 && break
  done
  if [[ $ok -eq 1 ]]; then
    echo "✓ $name ($code)"
    ((PASS++)) || true
  else
    echo "✗ $name (expected $expect, got $code)"
    head -c 300 /tmp/e2e-body.json 2>/dev/null; echo
    ((FAIL++)) || true
  fi
}

skip() {
  echo "⊘ $1 (skipped)"
  ((SKIP++)) || true
}

AUTH_P=(-H "Authorization: Bearer $PATIENT_TOKEN")
AUTH_S=(-H "Authorization: Bearer ${STAFF_TOKEN:-$PATIENT_TOKEN}")
JSON=(-H "Content-Type: application/json")

echo "=== ClinicOS E2E curl ==="
echo "Base: $BASE_URL | Clinic: $CLINIC"
echo

# --- Public ---
run "GET /health" 200 "$BASE_URL/health"

# --- Clinics (create needs no auth) ---
NEW_CLINIC=$(curl -s -X POST "$BASE_URL/clinics" "${JSON[@]}" \
  -d "{\"name\":\"E2E Clinic $(date +%s)\",\"timezone\":\"Asia/Kolkata\",\"contactEmail\":\"e2e@example.com\"}")
run "POST /clinics" 201 -X POST "$BASE_URL/clinics" "${JSON[@]}" \
  -d "{\"name\":\"E2E Clinic B $(date +%s)\",\"timezone\":\"Europe/London\",\"contactEmail\":\"e2e2@example.com\"}"

# --- Doctors ---
DOCTORS=$(curl -s "${AUTH_P[@]}" "$BASE_URL/clinics/$CLINIC/doctors")
run "GET /clinics/:clinicId/doctors" 200 "${AUTH_P[@]}" "$BASE_URL/clinics/$CLINIC/doctors"
# Prefer seeded Sharma doctor (first entry may be ad-hoc with empty template)
DOCTOR_ID=$(node -e "
const d=JSON.parse(process.argv[1]);
const docs=d.data||[];
const seeded=docs.find(x=>String(x.name||'').includes('Sharma'))||docs[0];
console.log(seeded?._id||'');
" "$DOCTORS")
[[ -z "$DOCTOR_ID" ]] && { echo "No doctor in seed — run npm run seed"; exit 1; }

WEEKLY='{"weeklyTemplate":{"MON":[{"start":"09:00","end":"13:00"},{"start":"15:00","end":"18:00"}],"TUE":[{"start":"10:00","end":"17:00"}],"WED":[{"start":"09:00","end":"13:00"},{"start":"15:00","end":"18:00"}],"THU":[{"start":"10:00","end":"17:00"}],"FRI":[{"start":"09:00","end":"13:00"},{"start":"15:00","end":"18:00"}],"SAT":[],"SUN":[]}}'

# --- Appointment types ---
TYPES=$(curl -s "${AUTH_P[@]}" "$BASE_URL/clinics/$CLINIC/appointment-types")
run "GET /clinics/:clinicId/appointment-types" 200 "${AUTH_P[@]}" "$BASE_URL/clinics/$CLINIC/appointment-types"
TYPE_ID=$(node -e "
const d=JSON.parse(process.argv[1]);
const t=(d.data||[]).find(x=>x.name==='General Consult')||(d.data||[])[0];
console.log(t?._id||'');
" "$TYPES")
[[ -z "$TYPE_ID" ]] && { echo "No appointment type"; exit 1; }

NEW_TYPE=$(curl -s -X POST "${AUTH_P[@]}" "${JSON[@]}" \
  "$BASE_URL/clinics/$CLINIC/appointment-types" \
  -d '{"name":"E2E Follow-up","durationMinutes":20,"isActive":true}')
PATCH_TYPE_ID=$(node -e "console.log(JSON.parse(process.argv[1])._id||'')" "$NEW_TYPE")
run "POST /clinics/:clinicId/appointment-types" 201 -X POST "${AUTH_P[@]}" "${JSON[@]}" \
  "$BASE_URL/clinics/$CLINIC/appointment-types" \
  -d '{"name":"E2E Type 2","durationMinutes":10,"isActive":true}'
if [[ -n "$PATCH_TYPE_ID" ]]; then
  run "PATCH /appointment-types/:id" 200 -X PATCH "${AUTH_P[@]}" "${JSON[@]}" \
    "$BASE_URL/appointment-types/$PATCH_TYPE_ID" \
    -d '{"durationMinutes":25}'
fi

# --- Availability ---
run "GET /doctors/:id/availability" 200 "${AUTH_P[@]}" "$BASE_URL/doctors/$DOCTOR_ID/availability"
run "PUT /doctors/:id/availability" 200 -X PUT "${AUTH_P[@]}" "${JSON[@]}" \
  "$BASE_URL/doctors/$DOCTOR_ID/availability" \
  -d "$WEEKLY"

FROM=$(date -v+5d +%F 2>/dev/null || date -d '+5 days' +%F)
TO=$(date -v+12d +%F 2>/dev/null || date -d '+12 days' +%F)
EX_DATE=$FROM

run "POST /doctors/:id/exceptions" 201 -X POST "${AUTH_P[@]}" "${JSON[@]}" \
  "$BASE_URL/doctors/$DOCTOR_ID/exceptions" \
  -d "{\"date\":\"$EX_DATE\",\"type\":\"block\",\"reason\":\"e2e lunch block\"}"

VALIDATE_BODY=$(node -e "
const t={MON:[{start:'09:00',end:'13:00'},{start:'15:00',end:'18:00'}],TUE:[{start:'10:00',end:'17:00'}],WED:[{start:'09:00',end:'13:00'},{start:'15:00',end:'18:00'}],THU:[{start:'10:00',end:'17:00'}],FRI:[{start:'09:00',end:'13:00'},{start:'15:00',end:'18:00'}],SAT:[],SUN:[]};
console.log(JSON.stringify({proposedTemplate:t,dateRange:{from:process.argv[1],to:process.argv[2]}}));
" "$FROM" "$TO")
run "POST /doctors/:id/availability/validate" 200 -X POST "${AUTH_P[@]}" "${JSON[@]}" \
  "$BASE_URL/doctors/$DOCTOR_ID/availability/validate" \
  -d "$VALIDATE_BODY"

# --- Slots ---
SLOTS=$(curl -s "${AUTH_P[@]}" \
  "$BASE_URL/slots?clinicId=$CLINIC&doctorId=$DOCTOR_ID&appointmentType=$TYPE_ID&from=$FROM&to=$TO")
run "GET /slots" 200 "${AUTH_P[@]}" \
  "$BASE_URL/slots?clinicId=$CLINIC&doctorId=$DOCTOR_ID&appointmentType=$TYPE_ID&from=$FROM&to=$TO"
SLOT_START=$(node -e "const s=JSON.parse(process.argv[1]).slots; console.log(s?.[0]?.start||'')" "$SLOTS")
[[ -z "$SLOT_START" ]] && { echo "No slots available in range"; exit 1; }

# --- Book + confirm + get + history + list ---
BOOK_CODE=$(curl -s -o /tmp/e2e-book.json -w "%{http_code}" -X POST "${AUTH_P[@]}" "${JSON[@]}" "$BASE_URL/appointments" \
  -d "{\"doctorId\":\"$DOCTOR_ID\",\"appointmentTypeId\":\"$TYPE_ID\",\"slotStart\":\"$SLOT_START\",\"patientId\":\"e2e_curl_patient\",\"idempotencyKey\":\"e2e-curl-$(date +%s)\"}")
if [[ "$BOOK_CODE" == "201" ]]; then
  echo "✓ POST /appointments ($BOOK_CODE)"
  ((PASS++)) || true
else
  echo "✗ POST /appointments (got $BOOK_CODE)"
  cat /tmp/e2e-book.json; echo
  ((FAIL++)) || true
fi
APPT_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/e2e-book.json','utf8'))._id||'')" 2>/dev/null || true)
[[ -z "$APPT_ID" ]] && { echo "Cannot continue without appointment id"; exit 1; }

run "PATCH /appointments/:id/confirm" 200 -X PATCH "${AUTH_P[@]}" "$BASE_URL/appointments/$APPT_ID/confirm"
run "GET /appointments/:id" 200 "${AUTH_P[@]}" "$BASE_URL/appointments/$APPT_ID"
run "GET /appointments/:id/history" 200 "${AUTH_P[@]}" "$BASE_URL/appointments/$APPT_ID/history"
run "GET /clinics/:clinicId/appointments?patientId=" 200 "${AUTH_P[@]}" \
  "$BASE_URL/clinics/$CLINIC/appointments?patientId=e2e_curl_patient"

# Reschedule to another slot if available
SLOT2=$(node -e "const s=JSON.parse(process.argv[1]).slots; console.log(s?.[1]?.start||s?.[0]?.start||'')" "$SLOTS")
if [[ -n "$SLOT2" && "$SLOT2" != "$SLOT_START" ]]; then
  run "PATCH /appointments/:id (reschedule)" 200 -X PATCH "${AUTH_P[@]}" "${JSON[@]}" \
    "$BASE_URL/appointments/$APPT_ID" \
    -d "{\"newSlotStart\":\"$SLOT2\",\"reason\":\"e2e reschedule\"}"
else
  skip "PATCH /appointments/:id (reschedule)"
fi

# Staff outcomes on past appointment — skip if future
run "PATCH /appointments/:id/noshow (staff)" "403 400 409" -X PATCH "${AUTH_S[@]}" "$BASE_URL/appointments/$APPT_ID/noshow"
run "PATCH /appointments/:id/complete (staff)" "403 400 409" -X PATCH "${AUTH_S[@]}" "$BASE_URL/appointments/$APPT_ID/complete"

# --- Waitlist (block a far-future day so no slots remain) ---
WL_DATE="2099-06-20"
WL_PATIENT="e2e_wait_patient"
curl -s -X POST "${AUTH_P[@]}" "${JSON[@]}" "$BASE_URL/doctors/$DOCTOR_ID/exceptions" \
  -d "{\"date\":\"$WL_DATE\",\"type\":\"block\",\"reason\":\"e2e waitlist day\"}" >/dev/null
WL_CODE=$(curl -s -o /tmp/e2e-wl.json -w "%{http_code}" -X POST "${AUTH_P[@]}" "${JSON[@]}" "$BASE_URL/waitlist" \
  -d "{\"doctorId\":\"$DOCTOR_ID\",\"appointmentTypeId\":\"$TYPE_ID\",\"targetDate\":\"$WL_DATE\",\"patientId\":\"$WL_PATIENT\",\"urgencyFlag\":false}")
if [[ "$WL_CODE" == "201" ]]; then
  echo "✓ POST /waitlist ($WL_CODE)"
  ((PASS++)) || true
  WL_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/e2e-wl.json','utf8'))._id||'')")
  run "GET /doctors/:id/waitlist" 200 "${AUTH_P[@]}" "$BASE_URL/doctors/$DOCTOR_ID/waitlist"
  run "POST /waitlist/:id/accept (no offer yet)" "403 404 410" -X POST "${AUTH_P[@]}" "$BASE_URL/waitlist/$WL_ID/accept"
  WL_TOKEN=$(node -e "
import './src/config/env.js';
import { signToken } from './src/utils/jwt.js';
console.log(signToken({ sub: process.argv[1], clinicId: process.argv[2], role: 'patient', name: process.argv[1] }));
" "$WL_PATIENT" "$CLINIC")
  run "DELETE /waitlist/:id" 200 -X DELETE -H "Authorization: Bearer $WL_TOKEN" "$BASE_URL/waitlist/$WL_ID"
else
  echo "✗ POST /waitlist (got $WL_CODE)"
  cat /tmp/e2e-wl.json; echo
  ((FAIL++)) || true
  run "GET /doctors/:id/waitlist" 200 "${AUTH_P[@]}" "$BASE_URL/doctors/$DOCTOR_ID/waitlist"
fi

# --- Cancel ---
run "DELETE /appointments/:id" 200 -X DELETE "${AUTH_P[@]}" "${JSON[@]}" \
  "$BASE_URL/appointments/$APPT_ID" \
  -d '{"cancelledBy":"patient","reason":"e2e curl done"}'

# --- Cleanup exception ---
run "DELETE /doctors/:id/exceptions/:date" 200 -X DELETE "${AUTH_P[@]}" \
  "$BASE_URL/doctors/$DOCTOR_ID/exceptions/$EX_DATE"

# --- Create doctor ---
run "POST /clinics/:clinicId/doctors" 201 -X POST "${AUTH_P[@]}" "${JSON[@]}" \
  "$BASE_URL/clinics/$CLINIC/doctors" \
  -d "{\"name\":\"Dr E2E\",\"specialisation\":\"GP\",\"email\":\"e2e.dr@example.com\",\"supportedAppointmentTypes\":[\"$TYPE_ID\"]}"

echo
echo "=== Summary: $PASS passed, $FAIL failed, $SKIP skipped ==="
[[ $FAIL -eq 0 ]] || exit 1
