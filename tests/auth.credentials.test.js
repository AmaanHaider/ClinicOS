import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { connectDb, disconnectDb } from "../src/config/db.js";
import { Clinic, User } from "../src/models/index.js";
import { verifyToken } from "../src/utils/jwt.js";

const app = createApp();

describe.sequential("auth credentials", { timeout: 60000 }, () => {
  const createdClinicIds = new Set();

  beforeAll(async () => {
    await connectDb();
  });

  afterEach(async () => {
    if (createdClinicIds.size === 0) return;
    const ids = [...createdClinicIds];
    await User.deleteMany({ clinicId: { $in: ids } });
    await Clinic.deleteMany({ _id: { $in: ids } });
    createdClinicIds.clear();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  async function createClinic() {
    const clinic = await Clinic.create({
      name: `Auth Clinic ${Date.now()}`,
      timezone: "Asia/Kolkata",
      isActive: true
    });
    createdClinicIds.add(clinic._id);
    return clinic;
  }

  it("signs up a clinic-scoped user and returns access token", async () => {
    const clinic = await createClinic();
    const res = await request(app)
      .post("/auth/signup")
      .send({
        clinicId: clinic._id,
        email: "owner@example.com",
        password: "StrongPass123!",
        name: "Owner User",
        role: "clinic_staff"
      });

    expect(res.status).toBe(201);
    expect(res.body.user.clinicId).toBe(clinic._id);
    expect(res.body.user.email).toBe("owner@example.com");
    expect(res.body.accessToken).toBeTypeOf("string");

    const payload = verifyToken(res.body.accessToken);
    expect(payload.clinicId).toBe(clinic._id);
    expect(payload.role).toBe("clinic_staff");
  });

  it("rejects duplicate email in the same clinic", async () => {
    const clinic = await createClinic();
    const body = {
      clinicId: clinic._id,
      email: "dupe@example.com",
      password: "StrongPass123!",
      name: "First User",
      role: "patient"
    };

    const first = await request(app).post("/auth/signup").send(body);
    const second = await request(app).post("/auth/signup").send({ ...body, name: "Second User" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("CONFLICT");
  });

  it("allows login with valid clinic/email/password", async () => {
    const clinic = await createClinic();
    const signupBody = {
      clinicId: clinic._id,
      email: "login@example.com",
      password: "StrongPass123!",
      name: "Login User",
      role: "patient"
    };
    await request(app).post("/auth/signup").send(signupBody);

    const login = await request(app).post("/auth/login").send({
      clinicId: clinic._id,
      email: "login@example.com",
      password: "StrongPass123!"
    });

    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe("patient");
    expect(login.body.accessToken).toBeTypeOf("string");
  });

  it("rejects login for wrong password", async () => {
    const clinic = await createClinic();
    await request(app).post("/auth/signup").send({
      clinicId: clinic._id,
      email: "badpass@example.com",
      password: "StrongPass123!",
      name: "Bad Pass User",
      role: "patient"
    });

    const login = await request(app).post("/auth/login").send({
      clinicId: clinic._id,
      email: "badpass@example.com",
      password: "WrongPass!"
    });

    expect(login.status).toBe(401);
    expect(login.body.error.code).toBe("UNAUTHORIZED");
  });
});
