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
  staffHeaders
} from "./helpers/fixtures.js";

const app = createApp();

describe.sequential("GET /clinics/:clinicId/appointments", { timeout: 120000 }, () => {
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

  it("requires date, from/to, or patientId", async () => {
    fixture = await createBookingFixture();
    const res = await request(app)
      .get(`/clinics/${fixture.clinic._id}/appointments`)
      .set(staffHeaders(fixture.clinic._id));
    expect(res.status).toBe(400);
  });

  it("lists appointments by patientId scoped to clinic", async () => {
    fixture = await createBookingFixture();
    const { res: bookRes } = await bookPendingAppointment(app, fixture, { patientId: "list_patient" });
    expect(bookRes.status).toBe(201);

    const res = await request(app)
      .get(`/clinics/${fixture.clinic._id}/appointments`)
      .query({ patientId: "list_patient" })
      .set(staffHeaders(fixture.clinic._id));
    expect(res.status).toBe(200);
    expect(res.body.data.some((a) => a._id === bookRes.body._id)).toBe(true);
  });

  it("rejects from/to range over 90 days", async () => {
    fixture = await createBookingFixture();
    const res = await request(app)
      .get(`/clinics/${fixture.clinic._id}/appointments`)
      .query({ from: "2026-01-01", to: "2026-06-01" })
      .set(staffHeaders(fixture.clinic._id));
    expect(res.status).toBe(400);
  });

  it("supports cursor pagination with after", async () => {
    fixture = await createBookingFixture();
    const first = await bookPendingAppointment(app, fixture, { patientId: "p1", idempotencyKey: "list-1" });
    await bookPendingAppointment(app, fixture, { patientId: "p2", idempotencyKey: "list-2" });

    const page1 = await request(app)
      .get(`/clinics/${fixture.clinic._id}/appointments`)
      .query({ patientId: "p1", limit: 1 })
      .set(staffHeaders(fixture.clinic._id));
    expect(page1.body.data).toHaveLength(1);
    expect(page1.body.data[0]._id).toBe(first.res.body._id);

    const allForPatient = await request(app)
      .get(`/clinics/${fixture.clinic._id}/appointments`)
      .query({ patientId: "p1", limit: 10 })
      .set(staffHeaders(fixture.clinic._id));
    expect(allForPatient.body.data).toHaveLength(1);
    expect(allForPatient.body.nextCursor).toBeNull();
  });

  it("filters by date", async () => {
    fixture = await createBookingFixture();
    const { res: bookRes, slot } = await bookPendingAppointment(app, fixture);
    const date = DateTime.fromISO(slot.start).toISODate();

    const res = await request(app)
      .get(`/clinics/${fixture.clinic._id}/appointments`)
      .query({ date })
      .set(staffHeaders(fixture.clinic._id));
    expect(res.status).toBe(200);
    expect(res.body.data.some((a) => a._id === bookRes.body._id)).toBe(true);
  });
});
