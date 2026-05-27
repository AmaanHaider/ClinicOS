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
  firstAvailableSlot,
  staffHeaders
} from "./helpers/fixtures.js";
import { AvailabilityException } from "../src/models/index.js";
import { getSlots } from "../src/services/slot.service.js";

const app = createApp();

describe.sequential("availability validate", { timeout: 120000 }, () => {
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

  it("does not false-flag appointments in additional exception hours", async () => {
    fixture = await createBookingFixture({
      mondayWindows: [{ start: "09:00", end: "12:00" }]
    });
    const sunday = DateTime.fromISO(fixture.monday, { zone: fixture.clinic.timezone }).minus({ days: 1 }).toISODate();

    await AvailabilityException.create({
      clinicId: fixture.clinic._id,
      doctorId: fixture.doctor._id,
      date: sunday,
      type: "additional",
      windows: [{ start: "18:00", end: "20:00" }]
    });

    const slotResult = await getSlots(fixture.clinic._id, {
      doctorId: fixture.doctor._id,
      appointmentType: fixture.consult._id,
      from: sunday,
      to: sunday
    });
    expect(slotResult.slots.length).toBeGreaterThan(0);

    const eveningSlot = slotResult.slots.find((s) => s.startLocal.startsWith("18:")) || slotResult.slots[0];
    const { res: bookRes } = await bookPendingAppointment(app, fixture, { slot: eveningSlot });
    await request(app)
      .patch(`/appointments/${bookRes.body._id}/confirm`)
      .set(authHeaders(fixture.clinic._id));

    const conflicts = await request(app)
      .post(`/doctors/${fixture.doctor._id}/availability/validate`)
      .set(staffHeaders(fixture.clinic._id))
      .send({
        proposedTemplate: {
          MON: [],
          TUE: [],
          WED: [],
          THU: [],
          FRI: [],
          SAT: [],
          SUN: []
        },
        dateRange: { from: sunday, to: sunday }
      });

    expect(conflicts.status).toBe(200);
    expect(conflicts.body.conflictCount).toBe(0);
  });

  it("flags conflicts when proposed template removes normal template hours", async () => {
    fixture = await createBookingFixture();
    const slot = await firstAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday);
    const { res: bookRes } = await bookPendingAppointment(app, fixture, { slot });
    await request(app)
      .patch(`/appointments/${bookRes.body._id}/confirm`)
      .set(authHeaders(fixture.clinic._id));

    const conflicts = await request(app)
      .post(`/doctors/${fixture.doctor._id}/availability/validate`)
      .set(staffHeaders(fixture.clinic._id))
      .send({
        proposedTemplate: {
          MON: [],
          TUE: [],
          WED: [],
          THU: [],
          FRI: [],
          SAT: [],
          SUN: []
        },
        dateRange: { from: fixture.monday, to: fixture.monday }
      });

    expect(conflicts.status).toBe(200);
    expect(conflicts.body.conflictCount).toBeGreaterThanOrEqual(1);
    expect(conflicts.body.conflicts.some((c) => c.appointmentId === bookRes.body._id)).toBe(true);
  });
});
