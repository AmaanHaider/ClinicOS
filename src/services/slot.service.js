import { DateTime } from "luxon";
import { AppointmentType, AvailabilityException, AvailabilityTemplate, Clinic, SlotReservation } from "../models/index.js";
import { BadRequestError, ConflictError, NotFoundError } from "../utils/errors.js";
import { parseDate } from "../utils/timezone.js";
import { computeAvailableSlots } from "./slot.engine.js";
import { requireDoctor } from "./doctor.service.js";

function activeReservationFilter(now = new Date()) {
  return {
    $or: [{ status: "confirmed" }, { status: "held", holdExpiresAt: { $gt: now } }]
  };
}

export async function assertNoActiveReservationOverlap(clinicId, { doctorId, slotStart, slotEnd, excludeReservationId }) {
  const start = slotStart instanceof Date ? slotStart : new Date(slotStart);
  const end = slotEnd instanceof Date ? slotEnd : new Date(slotEnd);
  const filter = {
    clinicId,
    doctorId,
    slotStart: { $lt: end },
    slotEnd: { $gt: start },
    ...activeReservationFilter()
  };
  if (excludeReservationId) filter._id = { $ne: excludeReservationId };

  const conflicting = await SlotReservation.findOne(filter).lean();
  if (conflicting) {
    throw new ConflictError("This slot has just been taken. Please select another.", { slotStart: start });
  }
}

export async function getSlots(clinicId, { doctorId, appointmentType, from, to }) {
  const fromDt = parseDate(from);
  const toDt = parseDate(to);
  if (toDt < fromDt) throw new BadRequestError("to must be after from");
  if (toDt.diff(fromDt, "days").days > 30) throw new BadRequestError("Maximum slot query range is 30 days");

  const doctor = await requireDoctor(clinicId, doctorId);
  if (!doctor.supportedAppointmentTypes.includes(appointmentType)) {
    return { doctorId, appointmentType, durationMinutes: null, from, to, slots: [], message: "Appointment type not supported by doctor" };
  }
  const [clinic, type, template, exceptions] = await Promise.all([
    Clinic.findById(clinicId).lean(),
    AppointmentType.findOne({ clinicId, _id: appointmentType, isActive: true }).lean(),
    AvailabilityTemplate.findOne({ clinicId, doctorId, isActive: true }).lean(),
    AvailabilityException.find({ clinicId, doctorId, date: { $gte: from, $lte: to } }).lean()
  ]);
  if (!clinic) throw new NotFoundError("Clinic not found");
  if (!type) throw new NotFoundError("Appointment type not found");
  if (!template) return { doctorId, appointmentType, durationMinutes: type.durationMinutes, from, to, slots: [] };

  const rangeStart = fromDt.startOf("day").toJSDate();
  const rangeEnd = toDt.endOf("day").toJSDate();
  const now = new Date();
  const reservations = await SlotReservation.find({
    clinicId,
    doctorId,
    slotStart: { $lt: rangeEnd },
    slotEnd: { $gt: rangeStart },
    ...activeReservationFilter(now)
  }).select("slotStart slotEnd status holdExpiresAt").lean();

  const slots = computeAvailableSlots({
    template: template.weeklyTemplate,
    exceptions,
    reservations,
    timezone: clinic.timezone,
    durationMinutes: type.durationMinutes,
    from,
    to,
    now
  });
  return { doctorId, appointmentType, durationMinutes: type.durationMinutes, from, to, slots };
}

export async function assertGeneratedSlot(clinicId, { doctorId, appointmentTypeId, slotStart }) {
  const slotDt = DateTime.fromJSDate(slotStart, { zone: "utc" });
  const date = slotDt.toISODate();
  const result = await getSlots(clinicId, { doctorId, appointmentType: appointmentTypeId, from: date, to: date });
  const iso = slotDt.toISO();
  const found = result.slots.find((slot) => DateTime.fromISO(slot.start).toUTC().toISO() === iso);
  if (!found) throw new BadRequestError("Requested slot is not available or not on a generated slot boundary");
  return found;
}
