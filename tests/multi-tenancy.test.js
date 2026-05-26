import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { setupTestDb, teardownTestDb } from "./helpers/db.js";
import {
  authHeaders,
  bookPendingAppointment,
  cleanupTwoClinicFixture,
  createTwoClinicFixture,
  firstAvailableSlot,
  staffHeaders
} from "./helpers/fixtures.js";
import { WaitlistEntry } from "../src/models/index.js";

const app = createApp();

describe.sequential("multi-tenancy", { timeout: 120000 }, () => {
  let two;

  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  afterEach(async () => {
    if (two) await cleanupTwoClinicFixture(two.clinicA._id, two.clinicB._id);
    two = null;
  });

  it("isolates doctors, types, bookings, appointments, and waitlist per clinic", async () => {
    two = await createTwoClinicFixture();

    const doctorsA = await request(app)
      .get(`/clinics/${two.clinicA._id}/doctors`)
      .set(staffHeaders(two.clinicA._id));
    expect(doctorsA.body.data.every((d) => d.clinicId === two.clinicA._id)).toBe(true);
    expect(doctorsA.body.data.some((d) => d._id === two.doctorB._id)).toBe(false);

    const bookBTypeOnA = await request(app)
      .post("/appointments")
      .set(authHeaders(two.clinicA._id))
      .send({
        doctorId: two.doctorA._id,
        appointmentTypeId: two.typeB._id,
        slotStart: "2099-06-01T09:00:00+05:30",
        patientId: "cross_type"
      });
    expect([400, 404]).toContain(bookBTypeOnA.status);

    const slotA = await firstAvailableSlot(two.clinicA._id, two.doctorA._id, two.typeA._id, two.mondayA);
    const fixtureA = {
      clinic: two.clinicA,
      doctor: two.doctorA,
      consult: two.typeA,
      monday: two.mondayA
    };
    const { res: bookRes } = await bookPendingAppointment(app, fixtureA, { slot: slotA });
    expect(bookRes.status).toBe(201);

    const crossGet = await request(app)
      .get(`/appointments/${bookRes.body._id}`)
      .set(staffHeaders(two.clinicB._id));
    expect(crossGet.status).toBe(404);

    const crossHistory = await request(app)
      .get(`/appointments/${bookRes.body._id}/history`)
      .set(staffHeaders(two.clinicB._id));
    expect(crossHistory.status).toBe(404);

    const crossAvail = await request(app)
      .put(`/doctors/${two.doctorA._id}/availability`)
      .set(staffHeaders(two.clinicB._id))
      .send({
        weeklyTemplate: {
          MON: [{ start: "09:00", end: "10:00" }],
          TUE: [], WED: [], THU: [], FRI: [], SAT: [], SUN: []
        }
      });
    expect(crossAvail.status).toBe(404);

    await WaitlistEntry.create({
      clinicId: two.clinicA._id,
      doctorId: two.doctorA._id,
      appointmentTypeId: two.typeA._id,
      targetDate: two.mondayA,
      patientId: "wait_a",
      status: "waiting",
      joinedAt: new Date()
    });

    const waitlistB = await request(app)
      .get(`/doctors/${two.doctorA._id}/waitlist`)
      .set(staffHeaders(two.clinicB._id));
    expect(waitlistB.status).toBe(200);
    expect(waitlistB.body.data).toHaveLength(0);

    const listB = await request(app)
      .get(`/clinics/${two.clinicB._id}/appointments`)
      .query({ patientId: "cross_type" })
      .set(staffHeaders(two.clinicB._id));
    expect(listB.body.data.some((a) => a._id === bookRes.body._id)).toBe(false);
  });
});
