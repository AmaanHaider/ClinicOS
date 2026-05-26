import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import { DateTime } from "luxon";
import { createApp } from "../src/app.js";
import { setupTestDb, teardownTestDb } from "./helpers/db.js";
import {
  authHeaders,
  cleanupFixture,
  createBookingFixture,
  firstAvailableSlot
} from "./helpers/fixtures.js";
import { Appointment, AppointmentEvent, SlotReservation } from "../src/models/index.js";
import { assertNoActiveReservationOverlap } from "../src/services/slot.service.js";
import { ConflictError } from "../src/utils/errors.js";

const app = createApp();

describe.sequential("POST /appointments", { timeout: 60000 }, () => {
  let fixture;

  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  afterEach(async () => {
    if (fixture?.clinic?._id) await cleanupFixture(fixture.clinic._id);
    fixture = null;
  });

  it("creates held reservation, pending appointment, and created event", async () => {
    fixture = await createBookingFixture();
    const slot = await firstAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday);

    const res = await request(app)
      .post("/appointments")
      .set(authHeaders(fixture.clinic._id))
      .send({
        doctorId: fixture.doctor._id,
        appointmentTypeId: fixture.consult._id,
        slotStart: slot.start,
        patientId: "patient_a",
        idempotencyKey: `idem-${Date.now()}-1`
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending");

    const reservation = await SlotReservation.findById(res.body.currentReservationId);
    expect(reservation.status).toBe("held");
    expect(reservation.holdExpiresAt).toBeTruthy();

    const events = await AppointmentEvent.find({ appointmentId: res.body._id });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("created");
  });

  it("returns 409 when the same slot is booked twice", async () => {
    fixture = await createBookingFixture();
    const slot = await firstAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday);

    const first = await request(app)
      .post("/appointments")
      .set(authHeaders(fixture.clinic._id))
      .send({
        doctorId: fixture.doctor._id,
        appointmentTypeId: fixture.consult._id,
        slotStart: slot.start,
        patientId: "patient_a",
        idempotencyKey: `idem-${Date.now()}-a`
      });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/appointments")
      .set(authHeaders(fixture.clinic._id))
      .send({
        doctorId: fixture.doctor._id,
        appointmentTypeId: fixture.consult._id,
        slotStart: slot.start,
        patientId: "patient_b",
        idempotencyKey: `idem-${Date.now()}-b`
      });
    expect(second.status).toBe(409);
    expect(second.body.error.message).toMatch(/taken/i);
  });

  it("returns existing appointment on idempotent retry", async () => {
    fixture = await createBookingFixture();
    const slot = await firstAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday);
    const idempotencyKey = `idem-${Date.now()}-retry`;
    const body = {
      doctorId: fixture.doctor._id,
      appointmentTypeId: fixture.consult._id,
      slotStart: slot.start,
      patientId: "patient_a",
      idempotencyKey
    };

    const first = await request(app).post("/appointments").set(authHeaders(fixture.clinic._id)).send(body);
    const second = await request(app).post("/appointments").set(authHeaders(fixture.clinic._id)).send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body._id).toBe(first.body._id);
    expect(await Appointment.countDocuments({ clinicId: fixture.clinic._id, idempotencyKey })).toBe(1);
  });

  it("rejects slot in the past", async () => {
    fixture = await createBookingFixture();
    const res = await request(app)
      .post("/appointments")
      .set(authHeaders(fixture.clinic._id))
      .send({
        doctorId: fixture.doctor._id,
        appointmentTypeId: fixture.consult._id,
        slotStart: DateTime.utc().minus({ hours: 1 }).toISO(),
        patientId: "patient_a"
      });
    expect(res.status).toBe(400);
  });

  it("rejects slot not on generated boundaries", async () => {
    fixture = await createBookingFixture();
    const slot = await firstAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday);
    const offGrid = DateTime.fromISO(slot.start).plus({ minutes: 7 }).toISO();

    const res = await request(app)
      .post("/appointments")
      .set(authHeaders(fixture.clinic._id))
      .send({
        doctorId: fixture.doctor._id,
        appointmentTypeId: fixture.consult._id,
        slotStart: offGrid,
        patientId: "patient_a"
      });
    expect(res.status).toBe(400);
  });

  it("rejects overlapping reservation with different slot start", async () => {
    fixture = await createBookingFixture();
    const slot = await firstAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday);
    const slotStart = new Date(slot.start);
    const slotEnd = DateTime.fromJSDate(slotStart).plus({ minutes: 30 }).toJSDate();

    await SlotReservation.create({
      clinicId: fixture.clinic._id,
      doctorId: fixture.doctor._id,
      appointmentTypeId: fixture.procedure._id,
      durationMinutes: 30,
      slotStart,
      slotEnd,
      status: "confirmed"
    });

    const overlapStart = DateTime.fromJSDate(slotStart).plus({ minutes: 15 }).toJSDate();
    const overlapEnd = DateTime.fromJSDate(overlapStart).plus({ minutes: 15 }).toJSDate();

    await expect(
      assertNoActiveReservationOverlap(fixture.clinic._id, {
        doctorId: fixture.doctor._id,
        slotStart: overlapStart,
        slotEnd: overlapEnd
      })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("lazily expires held reservation and allows new booking", async () => {
    fixture = await createBookingFixture({ narrowWindow: true });
    const slot = await firstAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday);
    const slotStart = new Date(slot.start);
    const slotEnd = new Date(slot.end);

    const [oldReservation] = await SlotReservation.create([{
      clinicId: fixture.clinic._id,
      doctorId: fixture.doctor._id,
      appointmentTypeId: fixture.consult._id,
      durationMinutes: 15,
      slotStart,
      slotEnd,
      status: "held",
      holdExpiresAt: DateTime.utc().minus({ minutes: 10 }).toJSDate()
    }]);
    const [oldAppointment] = await Appointment.create([{
      clinicId: fixture.clinic._id,
      doctorId: fixture.doctor._id,
      appointmentTypeId: fixture.consult._id,
      appointmentTypeName: "Consult",
      durationMinutes: 15,
      currentReservationId: oldReservation._id,
      currentSlotStart: slotStart,
      currentSlotEnd: slotEnd,
      status: "pending",
      patientId: "old_patient"
    }]);
    oldReservation.appointmentId = oldAppointment._id;
    await oldReservation.save();

    const res = await request(app)
      .post("/appointments")
      .set(authHeaders(fixture.clinic._id))
      .send({
        doctorId: fixture.doctor._id,
        appointmentTypeId: fixture.consult._id,
        slotStart: slot.start,
        patientId: "new_patient",
        idempotencyKey: `idem-${Date.now()}-expired`
      });

    expect(res.status).toBe(201);

    const expiredReservation = await SlotReservation.findById(oldReservation._id);
    expect(expiredReservation.status).toBe("expired");
    const expiredAppointment = await Appointment.findById(oldAppointment._id);
    expect(expiredAppointment.status).toBe("expired");
    expect(await AppointmentEvent.countDocuments({ appointmentId: oldAppointment._id, eventType: "expired" })).toBe(1);
  });
});
