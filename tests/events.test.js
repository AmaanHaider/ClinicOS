import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { setupTestDb, teardownTestDb } from "./helpers/db.js";
import {
  authHeaders,
  bookPendingAppointment,
  cleanupFixture,
  createBookingFixture,
  createTwoClinicFixture,
  cleanupTwoClinicFixture,
  staffHeaders
} from "./helpers/fixtures.js";
import { Appointment, AppointmentEvent } from "../src/models/index.js";
import { deriveAppointmentFromEvents, reconcileAppointment } from "../src/services/event.service.js";

const app = createApp();

describe.sequential("appointment events", { timeout: 120000 }, () => {
  let fixture;
  let two;

  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  afterEach(async () => {
    if (fixture?.clinic?._id) await cleanupFixture(fixture.clinic._id);
    if (two) await cleanupTwoClinicFixture(two.clinicA._id, two.clinicB._id);
    fixture = null;
    two = null;
  });

  it("writes created event on booking", async () => {
    fixture = await createBookingFixture();
    const { res: bookRes } = await bookPendingAppointment(app, fixture);
    expect(bookRes.status).toBe(201);
    const events = await AppointmentEvent.find({ appointmentId: bookRes.body._id }).sort({ createdAt: 1 });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("created");
    expect(events[0].newState).toBe("pending");
  });

  it("returns history ordered ascending with confirm event", async () => {
    fixture = await createBookingFixture();
    const { res: bookRes } = await bookPendingAppointment(app, fixture);
    await request(app)
      .patch(`/appointments/${bookRes.body._id}/confirm`)
      .set(authHeaders(fixture.clinic._id));

    const history = await request(app)
      .get(`/appointments/${bookRes.body._id}/history`)
      .set(authHeaders(fixture.clinic._id));
    expect(history.status).toBe(200);
    expect(history.body.events.length).toBeGreaterThanOrEqual(2);
    const types = history.body.events.map((e) => e.eventType);
    expect(types.indexOf("created")).toBeLessThan(types.indexOf("confirmed"));
    expect(history.body.events[history.body.events.length - 1].newState).toBe("confirmed");
  });

  it("returns 404 for cross-clinic appointment history", async () => {
    two = await createTwoClinicFixture();
    fixture = { clinic: two.clinicA, doctor: two.doctorA, consult: two.typeA, monday: two.mondayA };
    const { res: bookRes } = await bookPendingAppointment(app, fixture);
    const history = await request(app)
      .get(`/appointments/${bookRes.body._id}/history`)
      .set(staffHeaders(two.clinicB._id));
    expect(history.status).toBe(404);
  });

  it("replays lifecycle events to match final appointment state", async () => {
    fixture = await createBookingFixture();
    const { res: bookRes } = await bookPendingAppointment(app, fixture);
    const appointmentId = bookRes.body._id;

    await request(app)
      .patch(`/appointments/${appointmentId}/confirm`)
      .set(authHeaders(fixture.clinic._id));

    await request(app)
      .delete(`/appointments/${appointmentId}`)
      .set(authHeaders(fixture.clinic._id))
      .send({ cancelledBy: "patient", reason: "test" });

    const events = await AppointmentEvent.find({ appointmentId }).sort({ timestamp: 1 }).lean();
    const derived = deriveAppointmentFromEvents(events);
    expect(derived.status).toBe("cancelled");

    const appointment = await Appointment.findById(appointmentId).lean();
    const reconciliation = await reconcileAppointment(fixture.clinic._id, appointmentId);
    expect(reconciliation.matches).toBe(true);
    expect(reconciliation.derived.status).toBe(appointment.status);
  });

  it("increments event count on cancel", async () => {
    fixture = await createBookingFixture();
    const { res: bookRes } = await bookPendingAppointment(app, fixture);
    await request(app)
      .patch(`/appointments/${bookRes.body._id}/confirm`)
      .set(authHeaders(fixture.clinic._id));

    await request(app)
      .delete(`/appointments/${bookRes.body._id}`)
      .set(authHeaders(fixture.clinic._id))
      .send({ cancelledBy: "patient" });

    const events = await AppointmentEvent.find({ appointmentId: bookRes.body._id });
    expect(events.some((e) => e.eventType === "cancelled")).toBe(true);
    expect(events[events.length - 1].newState).toBe("cancelled");
  });
});
