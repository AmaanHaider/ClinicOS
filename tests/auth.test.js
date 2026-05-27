import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { setupTestDb, teardownTestDb } from "./helpers/db.js";
import {
  cleanupFixture,
  createBookingFixture,
  jwtHeaders
} from "./helpers/fixtures.js";
const app = createApp();

describe.sequential("auth", { timeout: 60000 }, () => {
  let fixture;

  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (fixture?.clinic?._id) await cleanupFixture(fixture.clinic._id);
    fixture = null;
  });

  it("accepts valid Bearer JWT", async () => {
    fixture = await createBookingFixture();
    const res = await request(app)
      .get(`/clinics/${fixture.clinic._id}/doctors`)
      .set(jwtHeaders(fixture.clinic._id, { role: "clinic_staff", actorId: "jwt_staff" }));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects invalid Bearer JWT", async () => {
    fixture = await createBookingFixture();
    const res = await request(app)
      .get(`/clinics/${fixture.clinic._id}/doctors`)
      .set({ Authorization: "Bearer not-a-real-token" });
    expect(res.status).toBe(401);
  });

  it("rejects expired Bearer JWT", async () => {
    fixture = await createBookingFixture();
    const token = jwt.sign(
      { sub: "p1", clinicId: fixture.clinic._id, role: "patient", name: "P" },
      env.JWT_SECRET,
      { expiresIn: "-1s" }
    );
    const res = await request(app)
      .get(`/clinics/${fixture.clinic._id}/doctors`)
      .set({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
  });

  it("rejects requests without Bearer token", async () => {
    fixture = await createBookingFixture();
    const res = await request(app)
      .get(`/clinics/${fixture.clinic._id}/doctors`);
    expect(res.status).toBe(401);
  });
});
