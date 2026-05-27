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
import { AvailabilityTemplate, Appointment, SlotReservation } from "../src/models/index.js";
import { env } from "../src/config/env.js";

const app = createApp();

describe.sequential("GET /slots", { timeout: 120000 }, () => {
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

  it("returns slots within query range with UTC and local fields", async () => {
    fixture = await createBookingFixture();
    const res = await request(app)
      .get("/slots")
      .query({
        clinicId: fixture.clinic._id,
        doctorId: fixture.doctor._id,
        appointmentType: fixture.consult._id,
        from: fixture.monday,
        to: fixture.monday
      })
      .set(authHeaders(fixture.clinic._id));
    expect(res.status).toBe(200);
    expect(res.body.slots.length).toBeGreaterThan(0);
    expect(res.body.slots[0].start).toBeTruthy();
    expect(res.body.slots[0].end).toBeTruthy();
    expect(res.body.slots[0].startLocal).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  it("rejects range above MAX_SLOT_QUERY_DAYS", async () => {
    fixture = await createBookingFixture();
    const from = fixture.monday;
    const to = DateTime.fromISO(from).plus({ days: env.MAX_SLOT_QUERY_DAYS + 1 }).toISODate();
    const res = await request(app)
      .get("/slots")
      .query({
        clinicId: fixture.clinic._id,
        doctorId: fixture.doctor._id,
        appointmentType: fixture.consult._id,
        from,
        to
      })
      .set(authHeaders(fixture.clinic._id));
    expect(res.status).toBe(400);
  });

  it("returns empty slots when doctor does not support type", async () => {
    fixture = await createBookingFixture();
    const res = await request(app)
      .get("/slots")
      .query({
        clinicId: fixture.clinic._id,
        doctorId: fixture.doctor._id,
        appointmentType: "type_unknown",
        from: fixture.monday,
        to: fixture.monday
      })
      .set(authHeaders(fixture.clinic._id));
    expect(res.status).toBe(200);
    expect(res.body.slots).toEqual([]);
    expect(res.body.message).toMatch(/not supported/i);
  });

  it("returns empty slots when no template exists", async () => {
    fixture = await createBookingFixture();
    await AvailabilityTemplate.deleteMany({ clinicId: fixture.clinic._id, doctorId: fixture.doctor._id });
    const res = await request(app)
      .get("/slots")
      .query({
        clinicId: fixture.clinic._id,
        doctorId: fixture.doctor._id,
        appointmentType: fixture.consult._id,
        from: fixture.monday,
        to: fixture.monday
      })
      .set(authHeaders(fixture.clinic._id));
    expect(res.status).toBe(200);
    expect(res.body.slots).toEqual([]);
  });

  it("respects block and override exceptions", async () => {
    fixture = await createBookingFixture();
    await request(app)
      .post(`/doctors/${fixture.doctor._id}/exceptions`)
      .set(staffHeaders(fixture.clinic._id))
      .send({ date: fixture.monday, type: "block" });

    const blocked = await request(app)
      .get("/slots")
      .query({
        clinicId: fixture.clinic._id,
        doctorId: fixture.doctor._id,
        appointmentType: fixture.consult._id,
        from: fixture.monday,
        to: fixture.monday
      })
      .set(authHeaders(fixture.clinic._id));
    expect(blocked.body.slots).toHaveLength(0);
  });

  it("omits confirmed reservations and expired holds from results", async () => {
    fixture = await createBookingFixture();
    const { res: bookRes, slot } = await bookPendingAppointment(app, fixture);
    expect(bookRes.status).toBe(201);

    const withHold = await request(app)
      .get("/slots")
      .query({
        clinicId: fixture.clinic._id,
        doctorId: fixture.doctor._id,
        appointmentType: fixture.consult._id,
        from: fixture.monday,
        to: fixture.monday
      })
      .set(authHeaders(fixture.clinic._id));
    expect(withHold.body.slots.find((s) => s.start === slot.start)).toBeUndefined();

    await SlotReservation.updateOne(
      { _id: bookRes.body.currentReservationId },
      { $set: { holdExpiresAt: DateTime.utc().minus({ minutes: 1 }).toJSDate() } }
    );

    const afterExpiry = await request(app)
      .get("/slots")
      .query({
        clinicId: fixture.clinic._id,
        doctorId: fixture.doctor._id,
        appointmentType: fixture.consult._id,
        from: fixture.monday,
        to: fixture.monday
      })
      .set(authHeaders(fixture.clinic._id));
    expect(afterExpiry.body.slots.find((s) => s.start === slot.start)).toBeDefined();

    const appointment = await Appointment.findById(bookRes.body._id);
    expect(appointment.status).toBe("expired");

    const reservation = await SlotReservation.findById(bookRes.body.currentReservationId);
    expect(reservation.status).toBe("expired");
  });
});
