import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDb, teardownTestDb } from "./helpers/db.js";
import { cleanupFixture, createBookingFixture } from "./helpers/fixtures.js";
import { Appointment, SlotReservation } from "../src/models/index.js";
import { DateTime } from "luxon";

describe.sequential("slotReservations partial unique index", { timeout: 60000 }, () => {
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

  async function baseReservation(overrides = {}) {
    const start = DateTime.utc().plus({ days: 30 }).startOf("hour");
    const end = start.plus({ minutes: 15 });
    return {
      clinicId: fixture.clinic._id,
      doctorId: fixture.doctor._id,
      appointmentTypeId: fixture.consult._id,
      durationMinutes: 15,
      slotStart: start.toJSDate(),
      slotEnd: end.toJSDate(),
      slotStartLocal: start.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      status: "held",
      holdExpiresAt: DateTime.utc().plus({ minutes: 5 }).toJSDate(),
      ...overrides
    };
  }

  it("rejects duplicate held and confirmed active reservations for same slot", async () => {
    fixture = await createBookingFixture();
    const data = await baseReservation();
    await SlotReservation.create(data);

    await expect(SlotReservation.create({ ...data, holdExpiresAt: DateTime.utc().plus({ minutes: 10 }).toJSDate() }))
      .rejects.toMatchObject({ code: 11000 });

    await expect(SlotReservation.create({ ...data, status: "confirmed", holdExpiresAt: undefined }))
      .rejects.toMatchObject({ code: 11000 });
  });

  it("allows released and expired reservations for same slot", async () => {
    fixture = await createBookingFixture();
    const data = await baseReservation();
    await SlotReservation.create({ ...data, status: "released", holdExpiresAt: undefined, releasedAt: new Date() });
    await SlotReservation.create({ ...data, status: "expired", holdExpiresAt: undefined });

    const active = await SlotReservation.countDocuments({
      clinicId: fixture.clinic._id,
      doctorId: fixture.doctor._id,
      slotStart: data.slotStart,
      status: { $in: ["held", "confirmed"] }
    });
    expect(active).toBe(0);
  });

  it("allows same idempotencyKey in different clinics", async () => {
    fixture = await createBookingFixture();
    const other = await createBookingFixture();
    const key = `shared-key-${Date.now()}`;

    await Appointment.create({
      clinicId: fixture.clinic._id,
      doctorId: fixture.doctor._id,
      appointmentTypeId: fixture.consult._id,
      durationMinutes: 15,
      status: "pending",
      idempotencyKey: key
    });
    await Appointment.create({
      clinicId: other.clinic._id,
      doctorId: other.doctor._id,
      appointmentTypeId: other.consult._id,
      durationMinutes: 15,
      status: "pending",
      idempotencyKey: key
    });

    await cleanupFixture(other.clinic._id);
  });
});
