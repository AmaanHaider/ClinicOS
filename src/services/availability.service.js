/**
 * Availability service — weekly templates, date exceptions (block/override/additional),
 * and dry-run validateAvailabilityChange (conflicts without persisting).
 */
import { DateTime } from "luxon";
import { Appointment, AppointmentType, AvailabilityException, AvailabilityTemplate, Clinic } from "../models/index.js";
import { BadRequestError, NotFoundError } from "../utils/errors.js";
import { parseDate } from "../utils/timezone.js";
import { validateWindows } from "../utils/slot.utils.js";
import { requireDoctor } from "./doctor.service.js";

const days = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

async function shortestDuration(clinicId) {
  const type = await AppointmentType.findOne({ clinicId, isActive: true }).sort({ durationMinutes: 1 }).lean();
  return type?.durationMinutes || 1;
}

export async function putAvailability(clinicId, doctorId, weeklyTemplate) {
  await requireDoctor(clinicId, doctorId);
  const min = await shortestDuration(clinicId);
  for (const day of days) validateWindows(weeklyTemplate[day] || [], min);
  return AvailabilityTemplate.findOneAndUpdate(
    { clinicId, doctorId, isActive: true },
    { $set: { weeklyTemplate }, $inc: { version: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

export async function getAvailability(clinicId, doctorId) {
  await requireDoctor(clinicId, doctorId);
  const template = await AvailabilityTemplate.findOne({ clinicId, doctorId, isActive: true }).lean();
  const today = DateTime.utc().toISODate();
  const exceptions = await AvailabilityException.find({ clinicId, doctorId, date: { $gte: today } }).sort({ date: 1 }).lean();
  return { doctorId, weeklyTemplate: template?.weeklyTemplate || Object.fromEntries(days.map((d) => [d, []])), exceptions };
}

export async function upsertException(clinicId, doctorId, data, actor) {
  await requireDoctor(clinicId, doctorId);
  const date = parseDate(data.date);
  if (date < DateTime.utc().startOf("day")) throw new BadRequestError("Exception date cannot be in the past");
  if (data.type !== "block") validateWindows(data.windows || [], await shortestDuration(clinicId));
  return AvailabilityException.findOneAndUpdate(
    { clinicId, doctorId, date: data.date },
    { $set: { ...data, windows: data.windows || [], createdBy: actor.id } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

export async function deleteException(clinicId, doctorId, date) {
  const deleted = await AvailabilityException.findOneAndDelete({ clinicId, doctorId, date });
  if (!deleted) throw new NotFoundError("Exception not found");
  return deleted;
}

function windowsForDate(date, proposedTemplate, exceptionsByDate, timezone) {
  const exception = exceptionsByDate[date];
  const weekday = DateTime.fromISO(date, { zone: timezone }).weekday;
  const day = days[weekday - 1];
  const base = proposedTemplate[day] || [];
  if (!exception) return base;
  if (exception.type === "block") return [];
  if (exception.type === "override") return exception.windows || [];
  if (exception.type === "additional") return [...base, ...(exception.windows || [])];
  return base;
}

function appointmentFitsWindows(appt, windows, timezone) {
  const local = DateTime.fromJSDate(appt.currentSlotStart, { zone: "utc" }).setZone(timezone);
  const mins = local.hour * 60 + local.minute;
  const endLocal = DateTime.fromJSDate(appt.currentSlotEnd, { zone: "utc" }).setZone(timezone);
  const endMins = endLocal.hour * 60 + endLocal.minute;
  return windows.some((w) => {
    const [sh, sm] = w.start.split(":").map(Number);
    const [eh, em] = w.end.split(":").map(Number);
    return mins >= sh * 60 + sm && endMins <= eh * 60 + em;
  });
}

/** POST .../availability/validate — dry-run; returns conflicting confirmed appointments. */
export async function validateAvailabilityChange(clinicId, doctorId, proposedTemplate, dateRange) {
  await requireDoctor(clinicId, doctorId);
  const from = parseDate(dateRange.from);
  const to = parseDate(dateRange.to);
  if (to < from) throw new BadRequestError("to must be after from");
  if (to.diff(from, "days").days > 90) throw new BadRequestError("Maximum validation range is 90 days");
  const clinic = await Clinic.findById(clinicId).lean();
  const exceptions = await AvailabilityException.find({
    clinicId,
    doctorId,
    date: { $gte: dateRange.from, $lte: dateRange.to }
  }).lean();
  const exceptionsByDate = Object.fromEntries(exceptions.map((e) => [e.date, e]));
  const appointments = await Appointment.find({
    clinicId,
    doctorId,
    status: "confirmed",
    currentSlotStart: { $gte: from.toJSDate(), $lte: to.endOf("day").toJSDate() }
  }).lean();
  const conflicts = appointments.filter((appt) => {
    const date = DateTime.fromJSDate(appt.currentSlotStart, { zone: "utc" }).setZone(clinic.timezone).toISODate();
    const windows = windowsForDate(date, proposedTemplate, exceptionsByDate, clinic.timezone);
    return !appointmentFitsWindows(appt, windows, clinic.timezone);
  });
  return { conflictCount: conflicts.length, conflicts: conflicts.map((a) => ({ appointmentId: a._id, slotStart: a.currentSlotStart, patientName: a.patient?.name, appointmentType: a.appointmentTypeName })) };
}

