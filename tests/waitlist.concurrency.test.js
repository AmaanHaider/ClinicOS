import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { setupTestDb, teardownTestDb } from "./helpers/db.js";
import {
  authHeaders,
  bookPendingAppointment,
  cleanupFixture,
  createBookingFixture,
  firstAvailableSlot
} from "./helpers/fixtures.js";
import { SlotOffer } from "../src/models/index.js";
import { offerNextWaitlistPatient } from "../src/services/waitlist.service.js";

const app = createApp();

describe.sequential("waitlist concurrency", { timeout: 120000 }, () => {
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

  it("creates at most one active offer for the same slot", async () => {
    fixture = await createBookingFixture({ narrowWindow: true });
    const slot = await firstAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday);
    const slotStart = new Date(slot.start);
    const slotEnd = new Date(slot.end);

    const { res: bookRes } = await bookPendingAppointment(app, fixture, { slot, patientId: "blocker" });
    expect(bookRes.status).toBe(201);
    await request(app)
      .patch(`/appointments/${bookRes.body._id}/confirm`)
      .set(authHeaders(fixture.clinic._id));

    await request(app).post("/waitlist").set(authHeaders(fixture.clinic._id, { actorId: "w1" })).send({
      doctorId: fixture.doctor._id,
      appointmentTypeId: fixture.consult._id,
      targetDate: fixture.monday,
      patientId: "w1"
    });
    await request(app).post("/waitlist").set(authHeaders(fixture.clinic._id, { actorId: "w2" })).send({
      doctorId: fixture.doctor._id,
      appointmentTypeId: fixture.consult._id,
      targetDate: fixture.monday,
      patientId: "w2"
    });

    const params = {
      clinicId: fixture.clinic._id,
      doctorId: fixture.doctor._id,
      appointmentTypeId: fixture.consult._id,
      targetDate: fixture.monday,
      slotStart,
      slotEnd
    };

    const results = await Promise.all([
      offerNextWaitlistPatient(params),
      offerNextWaitlistPatient(params)
    ]);

    const created = results.filter(Boolean);
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(await SlotOffer.countDocuments({
      clinicId: fixture.clinic._id,
      doctorId: fixture.doctor._id,
      appointmentTypeId: fixture.consult._id,
      slotStart,
      status: "offered"
    })).toBe(1);
  });
});
