import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { setupTestDb, teardownTestDb } from "./helpers/db.js";
import {
  authHeaders,
  bookPendingAppointment,
  cleanupFixture,
  createBookingFixture,
  nthAvailableSlot
} from "./helpers/fixtures.js";
import { Appointment, AppointmentEvent, SlotReservation } from "../src/models/index.js";

const app = createApp();

describe.sequential("appointment transition concurrency", { timeout: 120000 }, () => {
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

  it("allows only one concurrent confirm", async () => {
    fixture = await createBookingFixture();
    const { res: bookRes } = await bookPendingAppointment(app, fixture);
    const id = bookRes.body._id;

    const results = await Promise.all([
      request(app).patch(`/appointments/${id}/confirm`).set(authHeaders(fixture.clinic._id)),
      request(app).patch(`/appointments/${id}/confirm`).set(authHeaders(fixture.clinic._id))
    ]);

    const ok = results.filter((r) => r.status === 200);
    const conflicts = results.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(1);

    expect(await AppointmentEvent.countDocuments({ appointmentId: id, eventType: "confirmed" })).toBe(1);
    const reservation = await SlotReservation.findById(bookRes.body.currentReservationId);
    expect(reservation.status).toBe("confirmed");
  });

  it("allows only one concurrent cancel", async () => {
    fixture = await createBookingFixture();
    const { res: bookRes } = await bookPendingAppointment(app, fixture);
    const id = bookRes.body._id;
    const body = { cancelledBy: "patient", reason: "duplicate" };

    const results = await Promise.all([
      request(app).delete(`/appointments/${id}`).set(authHeaders(fixture.clinic._id)).send(body),
      request(app).delete(`/appointments/${id}`).set(authHeaders(fixture.clinic._id)).send(body)
    ]);

    const ok = results.filter((r) => r.status === 200);
    const conflicts = results.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(1);

    expect(await AppointmentEvent.countDocuments({ appointmentId: id, eventType: "cancelled" })).toBe(1);
    const reservation = await SlotReservation.findById(bookRes.body.currentReservationId);
    expect(reservation.status).toBe("released");
  });

  it("allows only one concurrent reschedule into the same target slot", async () => {
    fixture = await createBookingFixture();
    const slotA = await nthAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday, 0);
    const slotB = await nthAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday, 1);
    const slotC = await nthAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday, 2);

    const { res: appt1 } = await bookPendingAppointment(app, fixture, { slot: slotA, patientId: "p1" });
    const { res: appt2 } = await bookPendingAppointment(app, fixture, { slot: slotC, patientId: "p2" });
    await request(app).patch(`/appointments/${appt1.body._id}/confirm`).set(authHeaders(fixture.clinic._id));
    await request(app).patch(`/appointments/${appt2.body._id}/confirm`).set(authHeaders(fixture.clinic._id));

    const results = await Promise.all([
      request(app).patch(`/appointments/${appt1.body._id}`).set(authHeaders(fixture.clinic._id)).send({ newSlotStart: slotB.start }),
      request(app).patch(`/appointments/${appt2.body._id}`).set(authHeaders(fixture.clinic._id)).send({ newSlotStart: slotB.start })
    ]);

    const ok = results.filter((r) => r.status === 200);
    const conflicts = results.filter((r) => r.status !== 200);
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].status).toBe(409);

    const activeAtB = await SlotReservation.countDocuments({
      clinicId: fixture.clinic._id,
      doctorId: fixture.doctor._id,
      slotStart: new Date(slotB.start),
      status: { $in: ["held", "confirmed"] }
    });
    expect(activeAtB).toBe(1);
  });
});
