/**
 * Timezone utilities (Luxon) — parse dates, local HH:MM windows → UTC, weekday, day ranges.
 */
import { DateTime, IANAZone } from "luxon";
import { BadRequestError } from "./errors.js";

export function assertIanaTimezone(timezone) {
  if (!IANAZone.isValidZone(timezone)) throw new BadRequestError("Invalid IANA timezone");
}

export function parseDate(date) {
  const parsed = DateTime.fromISO(date, { zone: "utc" });
  if (!parsed.isValid || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestError("Date must be YYYY-MM-DD");
  return parsed;
}

export function parseUtcDateTime(value) {
  const parsed = DateTime.fromISO(value, { zone: "utc" });
  if (!parsed.isValid) throw new BadRequestError("Datetime must be valid ISO 8601");
  return parsed.toUTC();
}

export function localWindowToUtc(date, time, timezone) {
  const [hour, minute] = time.split(":").map(Number);
  const local = DateTime.fromISO(date, { zone: timezone }).set({ hour, minute, second: 0, millisecond: 0 });
  if (!local.isValid) throw new BadRequestError("Invalid local datetime");
  return local.toUTC();
}

export function weekdayForDate(date, timezone) {
  const weekday = DateTime.fromISO(date, { zone: timezone }).weekday;
  return ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"][weekday - 1];
}

export function daysInclusive(from, to, timezone = "utc") {
  let cursor = DateTime.fromISO(from, { zone: timezone }).startOf("day");
  const end = DateTime.fromISO(to, { zone: timezone }).startOf("day");
  const days = [];
  while (cursor <= end) {
    days.push(cursor.toISODate());
    cursor = cursor.plus({ days: 1 });
  }
  return days;
}

