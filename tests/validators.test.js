import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { BadRequestError } from "../src/utils/errors.js";
import { timeToMinutes, validateWindows } from "../src/utils/slot.utils.js";
import { createApp } from "../src/app.js";
import request from "supertest";
import { setupTestDb, teardownTestDb } from "./helpers/db.js";
import { authHeaders, cleanupFixture, createBookingFixture, staffHeaders } from "./helpers/fixtures.js";

const app = createApp();

describe("slot.utils validation", () => {
  it("rejects invalid time formats", () => {
    expect(() => timeToMinutes("9:00")).toThrow(BadRequestError);
    expect(() => timeToMinutes("09:00:00")).toThrow(BadRequestError);
    expect(() => timeToMinutes("9am")).toThrow(BadRequestError);
  });

  it("accepts valid HH:MM times", () => {
    expect(timeToMinutes("09:00")).toBe(540);
    expect(timeToMinutes("23:55")).toBe(23 * 60 + 55);
  });

  it("rejects start after end, equal bounds, overlap, and short windows", () => {
    expect(() => validateWindows([{ start: "10:00", end: "09:00" }])).toThrow(/before end/i);
    expect(() => validateWindows([{ start: "09:00", end: "09:00" }])).toThrow(/before end/i);
    expect(() => validateWindows([
      { start: "09:00", end: "10:00" },
      { start: "09:30", end: "11:00" }
    ])).toThrow(/overlap/i);
    expect(() => validateWindows([{ start: "09:00", end: "09:10" }], 15)).toThrow(/shorter/i);
  });

  it("accepts multiple non-overlapping windows", () => {
    expect(() => validateWindows([
      { start: "09:00", end: "12:00" },
      { start: "14:00", end: "17:00" }
    ], 15)).not.toThrow();
  });
});

describe.sequential("HTTP validation", { timeout: 60000 }, () => {
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

  it("rejects slot query range over MAX_SLOT_QUERY_DAYS", async () => {
    fixture = await createBookingFixture();
    const from = fixture.monday;
    const to = "2099-01-01";
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

  it("rejects availability validate range over 90 days", async () => {
    fixture = await createBookingFixture();
    const res = await request(app)
      .post(`/doctors/${fixture.doctor._id}/availability/validate`)
      .set(staffHeaders(fixture.clinic._id))
      .send({
        proposedTemplate: {
          MON: [{ start: "09:00", end: "12:00" }],
          TUE: [], WED: [], THU: [], FRI: [], SAT: [], SUN: []
        },
        dateRange: { from: "2026-01-01", to: "2026-06-01" }
      });
    expect(res.status).toBe(400);
  });

  it("rejects bad time format on availability put", async () => {
    fixture = await createBookingFixture();
    const res = await request(app)
      .put(`/doctors/${fixture.doctor._id}/availability`)
      .set(staffHeaders(fixture.clinic._id))
      .send({
        weeklyTemplate: {
          MON: [{ start: "9:00", end: "12:00" }],
          TUE: [], WED: [], THU: [], FRI: [], SAT: [], SUN: []
        }
      });
    expect(res.status).toBe(400);
  });

  it("rejects clinic URL mismatch with token", async () => {
    fixture = await createBookingFixture();
    const res = await request(app)
      .get(`/clinics/${fixture.clinic._id}_other/doctors`)
      .set(staffHeaders(fixture.clinic._id));
    expect(res.status).toBe(403);
  });
});
