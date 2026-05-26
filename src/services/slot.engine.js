import { DateTime } from "luxon";
import { daysInclusive, localWindowToUtc, weekdayForDate } from "../utils/timezone.js";

function effectiveWindowsForDate(template, exceptionsByDate, date, timezone) {
  const exception = exceptionsByDate.get(date);
  const weekday = weekdayForDate(date, timezone);
  const base = template?.[weekday] || [];
  if (!exception) return base;
  if (exception.type === "block") return [];
  if (exception.type === "override") return exception.windows || [];
  if (exception.type === "additional") return [...base, ...(exception.windows || [])];
  return base;
}

function reservationBlocksSlot(reservation, start, end) {
  const rStart = DateTime.fromJSDate(new Date(reservation.slotStart));
  const rEnd = DateTime.fromJSDate(new Date(reservation.slotEnd));
  return rStart < end && rEnd > start;
}

export function computeAvailableSlots({ template, exceptions = [], reservations = [], timezone, durationMinutes, from, to, now = new Date() }) {
  const exceptionsByDate = new Map(exceptions.map((ex) => [ex.date, ex]));
  const nowDt = DateTime.fromJSDate(now).toUTC();
  const slots = [];

  for (const date of daysInclusive(from, to, timezone)) {
    const windows = effectiveWindowsForDate(template, exceptionsByDate, date, timezone);
    for (const window of windows) {
      const windowStart = localWindowToUtc(date, window.start, timezone);
      const windowEnd = localWindowToUtc(date, window.end, timezone);
      let cursor = windowStart;
      while (cursor.plus({ minutes: durationMinutes }) <= windowEnd) {
        const end = cursor.plus({ minutes: durationMinutes });
        const activeConflict = reservations.some((reservation) => reservationBlocksSlot(reservation, cursor, end));
        if (!activeConflict && cursor >= nowDt) {
          slots.push({
            start: cursor.toISO(),
            end: end.toISO(),
            startLocal: cursor.setZone(timezone).toFormat("yyyy-MM-dd'T'HH:mm:ss")
          });
        }
        cursor = cursor.plus({ minutes: durationMinutes });
      }
    }
  }

  return slots;
}

