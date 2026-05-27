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

function normalizeReservations(reservations) {
  return reservations
    .map((reservation) => ({
      startMs: new Date(reservation.slotStart).getTime(),
      endMs: new Date(reservation.slotEnd).getTime()
    }))
    .sort((a, b) => a.startMs - b.startMs);
}

function hasOverlap(sortedReservations, startIndex, startMs, endMs) {
  for (let i = startIndex; i < sortedReservations.length; i += 1) {
    const reservation = sortedReservations[i];
    if (reservation.startMs >= endMs) break;
    if (reservation.startMs < endMs && reservation.endMs > startMs) return true;
  }
  return false;
}

export function computeAvailableSlots({ template, exceptions = [], reservations = [], timezone, durationMinutes, from, to, now = new Date() }) {
  const exceptionsByDate = new Map(exceptions.map((ex) => [ex.date, ex]));
  const sortedReservations = normalizeReservations(reservations);
  const nowDt = DateTime.fromJSDate(now).toUTC();
  const slots = [];
  let reservationIndex = 0;

  for (const date of daysInclusive(from, to, timezone)) {
    const windows = effectiveWindowsForDate(template, exceptionsByDate, date, timezone);
    for (const window of windows) {
      const windowStart = localWindowToUtc(date, window.start, timezone);
      const windowEnd = localWindowToUtc(date, window.end, timezone);
      let cursor = windowStart;
      while (cursor.plus({ minutes: durationMinutes }) <= windowEnd) {
        const end = cursor.plus({ minutes: durationMinutes });
        const startMs = cursor.toMillis();
        const endMs = end.toMillis();

        while (
          reservationIndex < sortedReservations.length
          && sortedReservations[reservationIndex].endMs <= startMs
        ) {
          reservationIndex += 1;
        }

        const activeConflict = hasOverlap(sortedReservations, reservationIndex, startMs, endMs);
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

// Exported for tests comparing naive vs optimised overlap logic.
export function reservationBlocksInterval(reservation, startMs, endMs) {
  const start = new Date(reservation.slotStart).getTime();
  const end = new Date(reservation.slotEnd).getTime();
  return start < endMs && end > startMs;
}
