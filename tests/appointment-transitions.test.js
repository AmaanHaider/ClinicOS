import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import { DateTime } from "luxon";
import { createApp } from "../src/app.js";
import { setupTestDb, teardownTestDb } from "./helpers/db.js";
import {
  authHeaders,
  bookPendingAppointment,
  cleanupFixture,
  createBookingFixture,
  firstAvailableSlot,
  nthAvailableSlot
} from "./helpers/fixtures.js";
import { Appointment, AppointmentEvent, SlotReservation } from "../src/models/index.js";

const app = createApp();

describe.sequential("appointment transitions", { timeout: 60000 }, () => {
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

  it("confirms pending appointment and reservation with event", async () => {
    fixture = await createBookingFixture();
    const { res: bookRes } = await bookPendingAppointment(app, fixture);
    expect(bookRes.status).toBe(201);

    const confirmRes = await request(app)
      .patch(`/appointments/${bookRes.body._id}/confirm`)
      .set(authHeaders(fixture.clinic._id));

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.status).toBe("confirmed");

    const reservation = await SlotReservation.findById(bookRes.body.currentReservationId);
    expect(reservation.status).toBe("confirmed");
    expect(reservation.holdExpiresAt).toBeFalsy();

    const events = await AppointmentEvent.find({ appointmentId: bookRes.body._id, eventType: "confirmed" });
    expect(events).toHaveLength(1);
  });

  it("returns 410 when confirming an expired hold", async () => {
    fixture = await createBookingFixture({ narrowWindow: true });
    const slot = await firstAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday);
    const { res: bookRes } = await bookPendingAppointment(app, fixture, { slot });
    expect(bookRes.status).toBe(201);

    await SlotReservation.updateOne(
      { _id: bookRes.body.currentReservationId },
      { $set: { holdExpiresAt: DateTime.utc().minus({ minutes: 10 }).toJSDate() } }
    );

    const confirmRes = await request(app)
      .patch(`/appointments/${bookRes.body._id}/confirm`)
      .set(authHeaders(fixture.clinic._id));

    expect(confirmRes.status).toBe(410);
  });

  it("cancels pending appointment and releases reservation", async () => {
    fixture = await createBookingFixture();
    const { res: bookRes } = await bookPendingAppointment(app, fixture);
    const cancelRes = await request(app)
      .delete(`/appointments/${bookRes.body._id}`)
      .set(authHeaders(fixture.clinic._id))
      .send({ cancelledBy: "patient", reason: "Changed plans" });

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe("cancelled");

    const reservation = await SlotReservation.findById(bookRes.body.currentReservationId);
    expect(reservation.status).toBe("released");
    expect(await AppointmentEvent.countDocuments({ appointmentId: bookRes.body._id, eventType: "cancelled" })).toBe(1);
  });

  it("cancels confirmed appointment", async () => {
    fixture = await createBookingFixture();
    const { res: bookRes } = await bookPendingAppointment(app, fixture);
    await request(app).patch(`/appointments/${bookRes.body._id}/confirm`).set(authHeaders(fixture.clinic._id));

    const cancelRes = await request(app)
      .delete(`/appointments/${bookRes.body._id}`)
      .set(authHeaders(fixture.clinic._id))
      .send({ cancelledBy: "clinic_staff", reason: "Doctor unavailable" });

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe("cancelled");
  });

  it("rejects cancel on already cancelled appointment", async () => {
    fixture = await createBookingFixture();
    const { res: bookRes } = await bookPendingAppointment(app, fixture);
    await request(app)
      .delete(`/appointments/${bookRes.body._id}`)
      .set(authHeaders(fixture.clinic._id))
      .send({ cancelledBy: "patient" });

    const second = await request(app)
      .delete(`/appointments/${bookRes.body._id}`)
      .set(authHeaders(fixture.clinic._id))
      .send({ cancelledBy: "patient" });

    expect(second.status).toBe(409);
  });

  it("reschedules confirmed appointment keeping same id", async () => {
    fixture = await createBookingFixture();
    const slotA = await nthAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday, 0);
    const slotB = await nthAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday, 1);

    const { res: bookRes } = await bookPendingAppointment(app, fixture, { slot: slotA });
    const appointmentId = bookRes.body._id;
    const oldReservationId = bookRes.body.currentReservationId;
    await request(app).patch(`/appointments/${appointmentId}/confirm`).set(authHeaders(fixture.clinic._id));

    const rescheduleRes = await request(app)
      .patch(`/appointments/${appointmentId}`)
      .set(authHeaders(fixture.clinic._id))
      .send({ newSlotStart: slotB.start, reason: "Patient requested change" });

    expect(rescheduleRes.status).toBe(200);
    expect(rescheduleRes.body._id).toBe(appointmentId);
    expect(new Date(rescheduleRes.body.currentSlotStart).toISOString()).toBe(new Date(slotB.start).toISOString());

    const oldReservation = await SlotReservation.findById(oldReservationId);
    expect(oldReservation.status).toBe("released");

    const newReservation = await SlotReservation.findById(rescheduleRes.body.currentReservationId);
    expect(newReservation.status).toBe("confirmed");

    const events = await AppointmentEvent.find({ appointmentId, eventType: "rescheduled" });
    expect(events).toHaveLength(1);
    expect(events[0].metadata.newSlotStart).toBeTruthy();
  });

  it("returns 409 when new reschedule slot is taken", async () => {
    fixture = await createBookingFixture();
    const slotA = await nthAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday, 0);
    const slotB = await nthAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday, 1);

    const { res: first } = await bookPendingAppointment(app, fixture, { slot: slotA, patientId: "p1" });
    await request(app).patch(`/appointments/${first.body._id}/confirm`).set(authHeaders(fixture.clinic._id));

    const { res: blocker } = await bookPendingAppointment(app, fixture, { slot: slotB, patientId: "p2" });
    await request(app).patch(`/appointments/${blocker.body._id}/confirm`).set(authHeaders(fixture.clinic._id));

    const rescheduleRes = await request(app)
      .patch(`/appointments/${first.body._id}`)
      .set(authHeaders(fixture.clinic._id))
      .send({ newSlotStart: slotB.start });

    expect(rescheduleRes.status).toBe(409);

    const unchanged = await Appointment.findById(first.body._id);
    expect(new Date(unchanged.currentSlotStart).toISOString()).toBe(new Date(slotA.start).toISOString());
  });

  it("allows pending appointment reschedule", async () => {
    fixture = await createBookingFixture();
    const slotA = await nthAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday, 0);
    const slotB = await nthAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday, 1);

    const { res: bookRes } = await bookPendingAppointment(app, fixture, { slot: slotA });
    const rescheduleRes = await request(app)
      .patch(`/appointments/${bookRes.body._id}`)
      .set(authHeaders(fixture.clinic._id))
      .send({ newSlotStart: slotB.start });

    expect(rescheduleRes.status).toBe(200);
    expect(rescheduleRes.body.status).toBe("pending");
    const reservation = await SlotReservation.findById(rescheduleRes.body.currentReservationId);
    expect(reservation.status).toBe("held");
  });

  it("rejects reschedule on cancelled appointment", async () => {
    fixture = await createBookingFixture();
    const { res: bookRes } = await bookPendingAppointment(app, fixture);
    await request(app)
      .delete(`/appointments/${bookRes.body._id}`)
      .set(authHeaders(fixture.clinic._id))
      .send({ cancelledBy: "patient" });

    const slotB = await firstAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday);
    const rescheduleRes = await request(app)
      .patch(`/appointments/${bookRes.body._id}`)
      .set(authHeaders(fixture.clinic._id))
      .send({ newSlotStart: slotB.start });

    expect(rescheduleRes.status).toBe(400);
  });
});
