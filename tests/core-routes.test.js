import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { setupTestDb, teardownTestDb } from "./helpers/db.js";
import {
  authHeaders,
  cleanupFixture,
  createBookingFixture,
  createTwoClinicFixture,
  cleanupTwoClinicFixture,
  staffHeaders
} from "./helpers/fixtures.js";
import { AppointmentType, AvailabilityException, AvailabilityTemplate } from "../src/models/index.js";

const app = createApp();

describe.sequential("core CRUD routes", { timeout: 120000 }, () => {
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

  it("creates clinic without auth", async () => {
    const res = await request(app).post("/clinics").send({
      name: `New Clinic ${Date.now()}`,
      timezone: "Asia/Kolkata"
    });
    expect(res.status).toBe(201);
    expect(res.body.timezone).toBe("Asia/Kolkata");
    await cleanupFixture(res.body._id);
  });

  it("rejects clinic create without timezone", async () => {
    const res = await request(app).post("/clinics").send({ name: "No TZ" });
    expect(res.status).toBe(400);
  });

  it("creates doctor with same-clinic appointment types", async () => {
    fixture = await createBookingFixture();
    const res = await request(app)
      .post(`/clinics/${fixture.clinic._id}/doctors`)
      .set(staffHeaders(fixture.clinic._id))
      .send({
        name: "Dr Extra",
        supportedAppointmentTypes: [fixture.consult._id, fixture.procedure._id]
      });
    expect(res.status).toBe(201);
    expect(res.body.clinicId).toBe(fixture.clinic._id);
  });

  it("rejects cross-clinic appointment types on doctor create", async () => {
    two = await createTwoClinicFixture();
    const res = await request(app)
      .post(`/clinics/${two.clinicA._id}/doctors`)
      .set(staffHeaders(two.clinicA._id))
      .send({
        name: "Dr Bad Types",
        supportedAppointmentTypes: [two.typeB._id]
      });
    expect(res.status).toBe(400);
  });

  it("lists active doctors by default", async () => {
    fixture = await createBookingFixture();
    const res = await request(app)
      .get(`/clinics/${fixture.clinic._id}/doctors`)
      .set(staffHeaders(fixture.clinic._id));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.every((d) => d.isActive !== false)).toBe(true);
  });

  it("creates and patches appointment types", async () => {
    fixture = await createBookingFixture();
    const create = await request(app)
      .post(`/clinics/${fixture.clinic._id}/appointment-types`)
      .set(staffHeaders(fixture.clinic._id))
      .send({ name: "Quick Visit", durationMinutes: 5 });
    expect(create.status).toBe(201);

    const bad = await request(app)
      .post(`/clinics/${fixture.clinic._id}/appointment-types`)
      .set(staffHeaders(fixture.clinic._id))
      .send({ name: "Bad", durationMinutes: 0 });
    expect(bad.status).toBe(400);

    const patch = await request(app)
      .patch(`/appointment-types/${create.body._id}`)
      .set(staffHeaders(fixture.clinic._id))
      .send({ isActive: false });
    expect(patch.status).toBe(200);
    expect(patch.body.isActive).toBe(false);
  });

  it("manages availability template and exceptions", async () => {
    fixture = await createBookingFixture();
    const put = await request(app)
      .put(`/doctors/${fixture.doctor._id}/availability`)
      .set(staffHeaders(fixture.clinic._id))
      .send({
        weeklyTemplate: {
          MON: [{ start: "09:00", end: "12:00" }],
          TUE: [{ start: "10:00", end: "14:00" }],
          WED: [], THU: [], FRI: [], SAT: [], SUN: []
        }
      });
    expect(put.status).toBe(200);

    const get = await request(app)
      .get(`/doctors/${fixture.doctor._id}/availability`)
      .set(staffHeaders(fixture.clinic._id));
    expect(get.status).toBe(200);
    expect(get.body.weeklyTemplate.MON).toHaveLength(1);

    const block = await request(app)
      .post(`/doctors/${fixture.doctor._id}/exceptions`)
      .set(staffHeaders(fixture.clinic._id))
      .send({ date: fixture.monday, type: "block", reason: "Holiday" });
    expect(block.status).toBe(201);

    const additional = await request(app)
      .post(`/doctors/${fixture.doctor._id}/exceptions`)
      .set(staffHeaders(fixture.clinic._id))
      .send({
        date: "2099-06-02",
        type: "additional",
        windows: [{ start: "18:00", end: "20:00" }]
      });
    expect(additional.status).toBe(201);

    await request(app)
      .delete(`/doctors/${fixture.doctor._id}/exceptions/${fixture.monday}`)
      .set(staffHeaders(fixture.clinic._id));

    const remaining = await AvailabilityException.countDocuments({
      clinicId: fixture.clinic._id,
      doctorId: fixture.doctor._id,
      date: fixture.monday
    });
    expect(remaining).toBe(0);
  });

  it("validates proposed availability against confirmed appointments", async () => {
    fixture = await createBookingFixture();
    const { bookPendingAppointment } = await import("./helpers/fixtures.js");
    const { res: bookRes } = await bookPendingAppointment(app, fixture);
    await request(app)
      .patch(`/appointments/${bookRes.body._id}/confirm`)
      .set(authHeaders(fixture.clinic._id));

    const conflicts = await request(app)
      .post(`/doctors/${fixture.doctor._id}/availability/validate`)
      .set(staffHeaders(fixture.clinic._id))
      .send({
        proposedTemplate: {
          MON: [],
          TUE: [], WED: [], THU: [], FRI: [], SAT: [], SUN: []
        },
        dateRange: { from: fixture.monday, to: fixture.monday }
      });
    expect(conflicts.status).toBe(200);
    expect(conflicts.body.conflictCount).toBeGreaterThanOrEqual(1);
  });
});
