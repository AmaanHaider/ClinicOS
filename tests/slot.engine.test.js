import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { computeAvailableSlots } from "../src/services/slot.engine.js";

const template = {
  MON: [{ start: "09:00", end: "10:00" }],
  TUE: [], WED: [], THU: [], FRI: [], SAT: [], SUN: []
};

describe("slot engine", () => {
  it("generates slots from weekly template", () => {
    const slots = computeAvailableSlots({
      template,
      timezone: "Asia/Kolkata",
      durationMinutes: 15,
      from: "2026-06-01",
      to: "2026-06-01",
      now: new Date("2026-05-01T00:00:00Z")
    });
    expect(slots).toHaveLength(4);
  });

  it("applies block exceptions", () => {
    const slots = computeAvailableSlots({
      template,
      exceptions: [{ date: "2026-06-01", type: "block", windows: [] }],
      timezone: "Asia/Kolkata",
      durationMinutes: 15,
      from: "2026-06-01",
      to: "2026-06-01",
      now: new Date("2026-05-01T00:00:00Z")
    });
    expect(slots).toHaveLength(0);
  });

  it("filters overlapping reservations", () => {
    const start = DateTime.fromISO("2026-06-01T09:00:00", { zone: "Asia/Kolkata" }).toUTC();
    const slots = computeAvailableSlots({
      template,
      reservations: [{ slotStart: start.toJSDate(), slotEnd: start.plus({ minutes: 30 }).toJSDate(), status: "confirmed" }],
      timezone: "Asia/Kolkata",
      durationMinutes: 15,
      from: "2026-06-01",
      to: "2026-06-01",
      now: new Date("2026-05-01T00:00:00Z")
    });
    expect(slots.map((s) => s.startLocal)).toEqual(["2026-06-01T09:30:00", "2026-06-01T09:45:00"]);
  });
});

