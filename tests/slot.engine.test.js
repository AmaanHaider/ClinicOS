import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { computeAvailableSlots } from "../src/services/slot.engine.js";

const mondayTemplate = {
  MON: [{ start: "09:00", end: "10:00" }],
  TUE: [], WED: [], THU: [], FRI: [], SAT: [], SUN: []
};

const wideMonday = {
  MON: [{ start: "09:00", end: "17:00" }],
  TUE: [], WED: [], THU: [], FRI: [], SAT: [], SUN: []
};

function localStarts(slots) {
  return slots.map((s) => s.startLocal.slice(11, 16));
}

describe("slot engine", () => {
  it("generates slots from weekly template", () => {
    const slots = computeAvailableSlots({
      template: mondayTemplate,
      timezone: "Asia/Kolkata",
      durationMinutes: 15,
      from: "2026-06-01",
      to: "2026-06-01",
      now: new Date("2026-05-01T00:00:00Z")
    });
    expect(localStarts(slots)).toEqual(["09:00", "09:15", "09:30", "09:45"]);
  });

  it("drops last partial slot that would extend past window end", () => {
    const slots = computeAvailableSlots({
      template: { MON: [{ start: "09:00", end: "10:10" }], TUE: [], WED: [], THU: [], FRI: [], SAT: [], SUN: [] },
      timezone: "Asia/Kolkata",
      durationMinutes: 30,
      from: "2026-06-01",
      to: "2026-06-01",
      now: new Date("2026-05-01T00:00:00Z")
    });
    expect(localStarts(slots)).toEqual(["09:00", "09:30"]);
    expect(localStarts(slots)).not.toContain("10:00");
  });

  it("applies block exceptions", () => {
    const slots = computeAvailableSlots({
      template: mondayTemplate,
      exceptions: [{ date: "2026-06-01", type: "block", windows: [] }],
      timezone: "Asia/Kolkata",
      durationMinutes: 15,
      from: "2026-06-01",
      to: "2026-06-01",
      now: new Date("2026-05-01T00:00:00Z")
    });
    expect(slots).toHaveLength(0);
  });

  it("applies override exceptions", () => {
    const slots = computeAvailableSlots({
      template: wideMonday,
      exceptions: [{ date: "2026-06-01", type: "override", windows: [{ start: "10:00", end: "14:00" }] }],
      timezone: "Asia/Kolkata",
      durationMinutes: 15,
      from: "2026-06-01",
      to: "2026-06-01",
      now: new Date("2026-05-01T00:00:00Z")
    });
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((s) => {
      const mins = Number(s.startLocal.slice(11, 13)) * 60 + Number(s.startLocal.slice(14, 16));
      return mins >= 10 * 60 && mins < 14 * 60;
    })).toBe(true);
  });

  it("applies additional exception windows", () => {
    const slots = computeAvailableSlots({
      template: { MON: [{ start: "09:00", end: "12:00" }], TUE: [], WED: [], THU: [], FRI: [], SAT: [], SUN: [] },
      exceptions: [{ date: "2026-06-01", type: "additional", windows: [{ start: "18:00", end: "20:00" }] }],
      timezone: "Asia/Kolkata",
      durationMinutes: 15,
      from: "2026-06-01",
      to: "2026-06-01",
      now: new Date("2026-05-01T00:00:00Z")
    });
    const hours = localStarts(slots).map((t) => t.slice(0, 2));
    expect(hours.some((h) => h >= "09" && h < "12")).toBe(true);
    expect(hours.some((h) => h >= "18")).toBe(true);
  });

  it("additional exception opens normally closed day", () => {
    const slots = computeAvailableSlots({
      template: { MON: [], TUE: [], WED: [], THU: [], FRI: [], SAT: [], SUN: [] },
      exceptions: [{ date: "2026-06-07", type: "additional", windows: [{ start: "10:00", end: "12:00" }] }],
      timezone: "Asia/Kolkata",
      durationMinutes: 15,
      from: "2026-06-07",
      to: "2026-06-07",
      now: new Date("2026-06-01T00:00:00Z")
    });
    expect(slots.length).toBeGreaterThan(0);
  });

  it("filters overlapping confirmed reservations", () => {
    const start = DateTime.fromISO("2026-06-01T09:00:00", { zone: "Asia/Kolkata" }).toUTC();
    const slots = computeAvailableSlots({
      template: mondayTemplate,
      reservations: [{ slotStart: start.toJSDate(), slotEnd: start.plus({ minutes: 30 }).toJSDate(), status: "confirmed" }],
      timezone: "Asia/Kolkata",
      durationMinutes: 15,
      from: "2026-06-01",
      to: "2026-06-01",
      now: new Date("2026-05-01T00:00:00Z")
    });
    expect(localStarts(slots)).toEqual(["09:30", "09:45"]);
  });

  it("filters past slots using now", () => {
    const now = DateTime.fromISO("2026-06-01T09:20:00", { zone: "Asia/Kolkata" }).toUTC();
    const slots = computeAvailableSlots({
      template: mondayTemplate,
      timezone: "Asia/Kolkata",
      durationMinutes: 15,
      from: "2026-06-01",
      to: "2026-06-01",
      now: now.toJSDate()
    });
    expect(localStarts(slots)).toEqual(["09:30", "09:45"]);
  });

  it("uses Luxon for DST boundaries in Europe/London", () => {
    const slots = computeAvailableSlots({
      template: { MON: [{ start: "09:00", end: "11:00" }], TUE: [], WED: [], THU: [], FRI: [], SAT: [], SUN: [] },
      timezone: "Europe/London",
      durationMinutes: 60,
      from: "2025-03-31",
      to: "2025-03-31",
      now: new Date("2025-03-01T00:00:00Z")
    });
    expect(slots).toHaveLength(2);
    expect(slots[0].start).toMatch(/T0[89]:00:00/);
    expect(slots[0].startLocal).toBe("2025-03-31T09:00:00");
  });
});
