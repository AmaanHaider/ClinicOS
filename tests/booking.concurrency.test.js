import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { setupTestDb, teardownTestDb } from "./helpers/db.js";
import {
  authHeaders,
  cleanupFixture,
  createBookingFixture,
  firstAvailableSlot
} from "./helpers/fixtures.js";
import { Appointment, AppointmentEvent, SlotReservation } from "../src/models/index.js";

const app = createApp();
const PARALLEL_REQUESTS = 20;

describe("booking concurrency", { timeout: 120000 }, () => {
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

  it(`allows exactly one of ${PARALLEL_REQUESTS} parallel bookings for the same slot`, async () => {
    fixture = await createBookingFixture({ narrowWindow: true });
    const slot = await firstAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday);

    const requests = Array.from({ length: PARALLEL_REQUESTS }, (_, i) =>
      request(app)
        .post("/appointments")
        .set(authHeaders(fixture.clinic._id, { actorId: `patient_${i}` }))
        .send({
          doctorId: fixture.doctor._id,
          appointmentTypeId: fixture.consult._id,
          slotStart: slot.start,
          patientId: `patient_${i}`,
          idempotencyKey: `concurrent-${Date.now()}-${i}`
        })
    );

    const results = await Promise.all(requests);
    const created = results.filter((r) => r.status === 201);
    const losers = results.filter((r) => r.status !== 201);

    expect(created).toHaveLength(1);
    expect(losers).toHaveLength(PARALLEL_REQUESTS - 1);
    expect(losers.every((r) => r.status === 409 || r.status === 400)).toBe(true);

    const activeReservations = await SlotReservation.countDocuments({
      clinicId: fixture.clinic._id,
      doctorId: fixture.doctor._id,
      slotStart: new Date(slot.start),
      status: { $in: ["held", "confirmed"] }
    });
    expect(activeReservations).toBe(1);

    const pendingAppointments = await Appointment.countDocuments({
      clinicId: fixture.clinic._id,
      doctorId: fixture.doctor._id,
      currentSlotStart: new Date(slot.start),
      status: "pending"
    });
    expect(pendingAppointments).toBe(1);

    const winnerId = created[0].body._id;
    const events = await AppointmentEvent.find({ appointmentId: winnerId, eventType: "created" });
    expect(events).toHaveLength(1);
  });
});
