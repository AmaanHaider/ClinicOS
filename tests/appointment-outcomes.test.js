import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { setupTestDb, teardownTestDb } from "./helpers/db.js";
import {
  authHeaders,
  bookPendingAppointment,
  cleanupFixture,
  createBookingFixture,
  createPastConfirmedAppointment,
  staffHeaders
} from "./helpers/fixtures.js";
import { Appointment, AppointmentEvent } from "../src/models/index.js";

const app = createApp();

describe.sequential("appointment outcomes", { timeout: 60000 }, () => {
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

  it("allows staff to mark past confirmed appointment as no_show", async () => {
    fixture = await createBookingFixture();
    const { appointmentId } = await createPastConfirmedAppointment(app, fixture);

    const res = await request(app)
      .patch(`/appointments/${appointmentId}/noshow`)
      .set(staffHeaders(fixture.clinic._id));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("no_show");

    const events = await AppointmentEvent.find({ appointmentId, eventType: "no_show" });
    expect(events).toHaveLength(1);
    expect(events[0].previousState).toBe("confirmed");
    expect(events[0].newState).toBe("no_show");
  });

  it("allows staff to mark past confirmed appointment as completed", async () => {
    fixture = await createBookingFixture();
    const { appointmentId } = await createPastConfirmedAppointment(app, fixture);

    const res = await request(app)
      .patch(`/appointments/${appointmentId}/complete`)
      .set(staffHeaders(fixture.clinic._id));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");

    const events = await AppointmentEvent.find({ appointmentId, eventType: "completed" });
    expect(events).toHaveLength(1);
    expect(events[0].newState).toBe("completed");
  });

  it("rejects no_show for future confirmed appointment", async () => {
    fixture = await createBookingFixture();
    const { res: bookRes } = await bookPendingAppointment(app, fixture);
    await request(app)
      .patch(`/appointments/${bookRes.body._id}/confirm`)
      .set(authHeaders(fixture.clinic._id));

    const res = await request(app)
      .patch(`/appointments/${bookRes.body._id}/noshow`)
      .set(staffHeaders(fixture.clinic._id));

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/not happened yet/i);
  });

  it("rejects complete for future confirmed appointment", async () => {
    fixture = await createBookingFixture();
    const { res: bookRes } = await bookPendingAppointment(app, fixture);
    await request(app)
      .patch(`/appointments/${bookRes.body._id}/confirm`)
      .set(authHeaders(fixture.clinic._id));

    const res = await request(app)
      .patch(`/appointments/${bookRes.body._id}/complete`)
      .set(staffHeaders(fixture.clinic._id));

    expect(res.status).toBe(400);
  });

  it("rejects patient marking no_show", async () => {
    fixture = await createBookingFixture();
    const { appointmentId } = await createPastConfirmedAppointment(app, fixture);

    const res = await request(app)
      .patch(`/appointments/${appointmentId}/noshow`)
      .set(authHeaders(fixture.clinic._id, { role: "patient" }));

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/clinic staff/i);

    const appt = await Appointment.findById(appointmentId);
    expect(appt.status).toBe("confirmed");
  });

  it("rejects patient marking complete", async () => {
    fixture = await createBookingFixture();
    const { appointmentId } = await createPastConfirmedAppointment(app, fixture);

    const res = await request(app)
      .patch(`/appointments/${appointmentId}/complete`)
      .set(authHeaders(fixture.clinic._id));

    expect(res.status).toBe(400);
  });

  it("rejects no_show on cancelled appointment", async () => {
    fixture = await createBookingFixture();
    const { appointmentId } = await createPastConfirmedAppointment(app, fixture);

    await request(app)
      .delete(`/appointments/${appointmentId}`)
      .set(authHeaders(fixture.clinic._id))
      .send({ cancelledBy: "patient" });

    const res = await request(app)
      .patch(`/appointments/${appointmentId}/noshow`)
      .set(staffHeaders(fixture.clinic._id));

    expect(res.status).toBe(409);
  });

  it("rejects complete on cancelled appointment", async () => {
    fixture = await createBookingFixture();
    const { appointmentId } = await createPastConfirmedAppointment(app, fixture);

    await request(app)
      .delete(`/appointments/${appointmentId}`)
      .set(authHeaders(fixture.clinic._id))
      .send({ cancelledBy: "clinic_staff" });

    const res = await request(app)
      .patch(`/appointments/${appointmentId}/complete`)
      .set(staffHeaders(fixture.clinic._id));

    expect(res.status).toBe(409);
  });
});
