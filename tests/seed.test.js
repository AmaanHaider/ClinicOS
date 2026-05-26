import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { connectDb, disconnectDb } from "../src/config/db.js";
import {
  Appointment,
  AppointmentType,
  AvailabilityException,
  AvailabilityTemplate,
  Clinic,
  Doctor,
  WaitlistEntry
} from "../src/models/index.js";
import { runSeed } from "../scripts/seed.js";
import { getSlots } from "../src/services/slot.service.js";
import { DateTime } from "luxon";

describe.sequential("seed script", { timeout: 120000 }, () => {
  beforeAll(async () => {
    await connectDb();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  it("creates spec data and exposes queryable slots", async () => {
    const summary = await runSeed();

    expect(summary.clinics).toBe(2);
    expect(summary.doctors).toBe(6);
    expect(summary.appointmentTypes).toBe(6);
    expect(summary.templates).toBe(6);
    expect(summary.exceptions).toBe(12);
    expect(summary.appointments).toBe(10);
    expect(summary.reservations).toBe(10);
    expect(summary.waitlistEntries).toBe(2);

    const india = await Clinic.findById("clinic_india");
    const doctor = await Doctor.findOne({ clinicId: "clinic_india" });
    const consult = await AppointmentType.findOne({ clinicId: "clinic_india", name: "General Consult" });
    const from = DateTime.now().setZone(india.timezone).plus({ days: 3 }).toISODate();
    const to = DateTime.now().setZone(india.timezone).plus({ days: 33 }).toISODate();
    const { slots } = await getSlots("clinic_india", {
      doctorId: doctor._id,
      appointmentType: consult._id,
      from,
      to
    });
    expect(slots.length).toBeGreaterThan(0);

    const collections = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
    expect(collections).not.toContain("slots");

    expect(await Appointment.countDocuments({ status: "confirmed" })).toBe(10);
    expect(await WaitlistEntry.countDocuments({})).toBe(2);
    expect(await AvailabilityTemplate.countDocuments({})).toBe(6);
    expect(await AvailabilityException.countDocuments({})).toBe(12);
  });
});
