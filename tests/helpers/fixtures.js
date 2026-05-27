import { DateTime } from "luxon";
import request from "supertest";
import {
  Appointment,
  AppointmentEvent,
  AppointmentType,
  AvailabilityException,
  AvailabilityTemplate,
  Clinic,
  Doctor,
  SlotOffer,
  SlotReservation,
  WaitlistEntry
} from "../../src/models/index.js";
import { getSlots } from "../../src/services/slot.service.js";
import { signToken } from "../../src/utils/jwt.js";

const EMPTY_WEEK = { MON: [], TUE: [], WED: [], THU: [], FRI: [], SAT: [], SUN: [] };

export function nextMondayDate(timezone, weeksAhead = 10) {
  let d = DateTime.now().setZone(timezone).plus({ weeks: weeksAhead }).startOf("day");
  while (d.weekday !== 1) d = d.plus({ days: 1 });
  return d.toISODate();
}

export async function createBookingFixture({ narrowWindow = false, mondayWindows } = {}) {
  const clinic = await Clinic.create({
    name: `Test Clinic ${Date.now()}`,
    timezone: "Asia/Kolkata",
    isActive: true
  });
  const consult = await AppointmentType.create({
    clinicId: clinic._id,
    name: "Consult",
    durationMinutes: 15,
    isActive: true
  });
  const procedure = await AppointmentType.create({
    clinicId: clinic._id,
    name: "Procedure",
    durationMinutes: 30,
    isActive: true
  });
  const doctor = await Doctor.create({
    clinicId: clinic._id,
    name: "Dr Test",
    supportedAppointmentTypes: [consult._id, procedure._id],
    isActive: true
  });
  const monday = nextMondayDate(clinic.timezone);
  const weeklyTemplate = {
    ...EMPTY_WEEK,
    MON: mondayWindows || (narrowWindow ? [{ start: "09:00", end: "09:15" }] : [{ start: "09:00", end: "12:00" }])
  };
  await AvailabilityTemplate.create({
    clinicId: clinic._id,
    doctorId: doctor._id,
    weeklyTemplate,
    isActive: true
  });
  return { clinic, doctor, consult, procedure, monday };
}

export async function firstAvailableSlot(clinicId, doctorId, appointmentTypeId, date) {
  const result = await getSlots(clinicId, {
    doctorId,
    appointmentType: appointmentTypeId,
    from: date,
    to: date
  });
  if (!result.slots.length) throw new Error(`No slots available for ${date}`);
  return result.slots[0];
}

export async function nthAvailableSlot(clinicId, doctorId, appointmentTypeId, date, index = 0) {
  const result = await getSlots(clinicId, {
    doctorId,
    appointmentType: appointmentTypeId,
    from: date,
    to: date
  });
  if (!result.slots[index]) throw new Error(`Slot index ${index} not available for ${date}`);
  return result.slots[index];
}

export async function bookPendingAppointment(expressApp, fixture, { slot, patientId = "patient_test", idempotencyKey } = {}) {
  const chosen = slot || await firstAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday);
  const res = await request(expressApp)
    .post("/appointments")
    .set(authHeaders(fixture.clinic._id))
    .send({
      doctorId: fixture.doctor._id,
      appointmentTypeId: fixture.consult._id,
      slotStart: chosen.start,
      patientId,
      idempotencyKey: idempotencyKey || `book-${Date.now()}-${Math.random()}`
    });
  return { res, slot: chosen };
}

export async function cleanupFixture(clinicId) {
  await Promise.all([
    SlotOffer.deleteMany({ clinicId }),
    WaitlistEntry.deleteMany({ clinicId }),
    AppointmentEvent.deleteMany({ clinicId }),
    SlotReservation.deleteMany({ clinicId }),
    Appointment.deleteMany({ clinicId }),
    AvailabilityTemplate.deleteMany({ clinicId }),
    AvailabilityException.deleteMany({ clinicId }),
    Doctor.deleteMany({ clinicId }),
    AppointmentType.deleteMany({ clinicId }),
    Clinic.deleteOne({ _id: clinicId })
  ]);
}

export function authHeaders(clinicId, overrides = {}) {
  return jwtHeaders(clinicId, overrides);
}

/** Signed JWT (preferred for production-like tests). */
export function jwtHeaders(clinicId, overrides = {}) {
  const token = signToken({
    sub: overrides.actorId || "test_patient",
    clinicId,
    role: overrides.role || "patient",
    name: overrides.name || "Test Patient"
  });
  return { Authorization: `Bearer ${token}` };
}

export function staffHeaders(clinicId) {
  return jwtHeaders(clinicId, { role: "clinic_staff", actorId: "staff_test", name: "Staff User" });
}

export function staffJwtHeaders(clinicId) {
  return jwtHeaders(clinicId, { role: "clinic_staff", actorId: "staff_test", name: "Staff User" });
}

/** Book, confirm, then move slot into the past for no-show/complete tests. */
/** Two isolated clinics for multi-tenancy tests. */
export async function createTwoClinicFixture() {
  const clinicA = await Clinic.create({
    name: `Clinic A ${Date.now()}`,
    timezone: "Asia/Kolkata",
    isActive: true
  });
  const clinicB = await Clinic.create({
    name: `Clinic B ${Date.now()}`,
    timezone: "Europe/London",
    isActive: true
  });

  async function seedClinic(clinic) {
    const consult = await AppointmentType.create({
      clinicId: clinic._id,
      name: "Consult",
      durationMinutes: 15,
      isActive: true
    });
    const doctor = await Doctor.create({
      clinicId: clinic._id,
      name: `Dr ${clinic._id}`,
      supportedAppointmentTypes: [consult._id],
      isActive: true
    });
    const monday = nextMondayDate(clinic.timezone);
    await AvailabilityTemplate.create({
      clinicId: clinic._id,
      doctorId: doctor._id,
      weeklyTemplate: { ...EMPTY_WEEK, MON: [{ start: "09:00", end: "12:00" }] },
      isActive: true
    });
    return { consult, doctor, monday };
  }

  const a = await seedClinic(clinicA);
  const b = await seedClinic(clinicB);
  return {
    clinicA,
    clinicB,
    doctorA: a.doctor,
    doctorB: b.doctor,
    typeA: a.consult,
    typeB: b.consult,
    mondayA: a.monday,
    mondayB: b.monday
  };
}

export async function cleanupTwoClinicFixture(clinicAId, clinicBId) {
  await cleanupFixture(clinicAId);
  await cleanupFixture(clinicBId);
}

export async function createPastConfirmedAppointment(expressApp, fixture) {
  const { res: bookRes } = await bookPendingAppointment(expressApp, fixture);
  if (bookRes.status !== 201) throw new Error(`booking failed with status ${bookRes.status}`);
  const appointmentId = bookRes.body._id;
  await request(expressApp)
    .patch(`/appointments/${appointmentId}/confirm`)
    .set(authHeaders(fixture.clinic._id));

  const pastStart = DateTime.utc().minus({ hours: 2 }).toJSDate();
  const pastEnd = DateTime.utc().minus({ hours: 1, minutes: 45 }).toJSDate();
  await Appointment.updateOne(
    { _id: appointmentId },
    { $set: { currentSlotStart: pastStart, currentSlotEnd: pastEnd } }
  );
  return { appointmentId, reservationId: bookRes.body.currentReservationId };
}
