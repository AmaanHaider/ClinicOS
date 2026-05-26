import { BadRequestError } from "./errors.js";

const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function timeToMinutes(time) {
  const match = timeRegex.exec(time);
  if (!match) throw new BadRequestError("Time must be HH:MM");
  return Number(match[1]) * 60 + Number(match[2]);
}

export function validateWindows(windows, minMinutes = 1) {
  const sorted = [...windows].sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i];
    const start = timeToMinutes(current.start);
    const end = timeToMinutes(current.end);
    if (start >= end) throw new BadRequestError("Window start must be before end");
    if (end - start < minMinutes) throw new BadRequestError("Window is shorter than minimum appointment duration");
    const previous = sorted[i - 1];
    if (previous && timeToMinutes(previous.end) > start) throw new BadRequestError("Windows cannot overlap");
  }
}

export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

