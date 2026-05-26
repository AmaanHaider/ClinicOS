import { DateTime } from "luxon";
import { Appointment, AppointmentType, SlotReservation } from "../models/index.js";
import { BadRequestError, ConflictError, GoneError, NotFoundError } from "../utils/errors.js";
import { parseUtcDateTime } from "../utils/timezone.js";
import { withTransaction } from "../utils/transactions.js";
import { requireDoctor } from "./doctor.service.js";
import { requireAppointmentType } from "./appointment-type.service.js";
import { assertGeneratedSlot } from "./slot.service.js";
import { writeEvent } from "./event.service.js";
import { env } from "../config/env.js";

const systemActor = { id: "system", role: "system", name: "System" };

async function expireBlockingHold({ clinicId, doctorId, slotStart, actor = systemActor }) {
  const now = new Date();
  return withTransaction(async (session) => {
    const expired = await SlotReservation.findOneAndUpdate(
      { clinicId, doctorId, slotStart, status: "held", holdExpiresAt: { $lte: now } },
      { $set: { status: "expired" } },
      { new: true, session }
    );
    if (!expired) return false;
    const appointment = await Appointment.findOneAndUpdate(
      { _id: expired.appointmentId, clinicId, status: "pending" },
      { $set: { status: "expired" }, $inc: { version: 1 } },
      { new: true, session }
    );
    if (appointment) {
      await writeEvent({ appointment, eventType: "expired", actor, previousState: "pending", newState: "expired", session });
    }
    return true;
  });
}

export async function createAppointment(clinicId, data, actor, retry = true) {
  if (data.idempotencyKey) {
    const existing = await Appointment.findOne({ clinicId, idempotencyKey: data.idempotencyKey });
    if (existing) return { appointment: existing, statusCode: 200 };
  }
  const slotStart = parseUtcDateTime(data.slotStart).toJSDate();
  if (slotStart <= new Date()) throw new BadRequestError("slotStart must be in the future");
  const doctor = await requireDoctor(clinicId, data.doctorId);
  const type = await requireAppointmentType(clinicId, data.appointmentTypeId);
  if (!doctor.supportedAppointmentTypes.includes(type._id)) throw new BadRequestError("Appointment type not supported by doctor");
  const slotEnd = DateTime.fromJSDate(slotStart, { zone: "utc" }).plus({ minutes: type.durationMinutes }).toJSDate();
  const generated = await assertGeneratedSlot(clinicId, { doctorId: doctor._id, appointmentTypeId: type._id, slotStart });

  try {
    const result = await withTransaction(async (session) => {
      const [reservation] = await SlotReservation.create([{
        clinicId,
        doctorId: doctor._id,
        appointmentTypeId: type._id,
        durationMinutes: type.durationMinutes,
        slotStart,
        slotEnd,
        slotStartLocal: generated.startLocal,
        status: "held",
        holdExpiresAt: DateTime.utc().plus({ minutes: env.PENDING_HOLD_MINUTES }).toJSDate()
      }], { session });

      const [appointment] = await Appointment.create([{
        clinicId,
        doctorId: doctor._id,
        patientId: data.patientId,
        appointmentTypeId: type._id,
        appointmentTypeName: type.name,
        durationMinutes: type.durationMinutes,
        currentReservationId: reservation._id,
        currentSlotStart: slotStart,
        currentSlotEnd: slotEnd,
        status: "pending",
        idempotencyKey: data.idempotencyKey,
        patient: data.patient || {},
        notes: data.notes
      }], { session });

      reservation.appointmentId = appointment._id;
      await reservation.save({ session });
      await writeEvent({ appointment, eventType: "created", actor, previousState: null, newState: "pending", session });
      return { appointment, reservation, statusCode: 201 };
    });
    return result;
  } catch (err) {
    if (err?.code === 11000 && retry) {
      const expired = await expireBlockingHold({ clinicId, doctorId: doctor._id, slotStart, actor });
      if (expired) return createAppointment(clinicId, data, actor, false);
    }
    if (err?.code === 11000) throw new ConflictError("This slot has just been taken. Please select another.", { slotStart });
    throw err;
  }
}

export async function confirmAppointment(clinicId, id, actor) {
  const now = new Date();
  return withTransaction(async (session) => {
    const appointment = await Appointment.findOne({ _id: id, clinicId }).session(session);
    if (!appointment) throw new NotFoundError("Appointment not found");
    if (appointment.status !== "pending") throw new ConflictError("Appointment is not pending");
    const reservation = await SlotReservation.findOne({ _id: appointment.currentReservationId, clinicId }).session(session);
    if (!reservation || reservation.status !== "held" || reservation.holdExpiresAt <= now) throw new GoneError("Booking hold has expired");
    appointment.status = "confirmed";
    appointment.version += 1;
    reservation.status = "confirmed";
    reservation.holdExpiresAt = undefined;
    await reservation.save({ session });
    await appointment.save({ session });
    await writeEvent({ appointment, eventType: "confirmed", actor, previousState: "pending", newState: "confirmed", session });
    return appointment;
  });
}

export async function cancelAppointment(clinicId, id, data, actor) {
  return withTransaction(async (session) => {
    const appointment = await Appointment.findOne({ _id: id, clinicId }).session(session);
    if (!appointment) throw new NotFoundError("Appointment not found");
    if (!["pending", "confirmed"].includes(appointment.status)) throw new BadRequestError("Appointment cannot be cancelled");
    const previousState = appointment.status;
    appointment.status = "cancelled";
    appointment.cancelledBy = data.cancelledBy;
    appointment.cancellationReason = data.reason;
    appointment.version += 1;
    await SlotReservation.updateOne({ _id: appointment.currentReservationId, clinicId, status: { $in: ["held", "confirmed"] } }, { $set: { status: "released", releasedAt: new Date() } }, { session });
    await appointment.save({ session });
    await writeEvent({ appointment, eventType: "cancelled", actor, previousState, newState: "cancelled", metadata: data, session });
    return appointment;
  });
}

export async function rescheduleAppointment(clinicId, id, data, actor) {
  const appointment = await Appointment.findOne({ _id: id, clinicId });
  if (!appointment) throw new NotFoundError("Appointment not found");
  if (!["pending", "confirmed"].includes(appointment.status)) throw new BadRequestError("Appointment cannot be rescheduled");
  const newSlotStart = parseUtcDateTime(data.newSlotStart).toJSDate();
  if (newSlotStart.getTime() === appointment.currentSlotStart.getTime()) throw new BadRequestError("New slot is the same as current slot");
  const type = await AppointmentType.findOne({ clinicId, _id: appointment.appointmentTypeId });
  const newSlotEnd = DateTime.fromJSDate(newSlotStart, { zone: "utc" }).plus({ minutes: appointment.durationMinutes }).toJSDate();
  const generated = await assertGeneratedSlot(clinicId, { doctorId: appointment.doctorId, appointmentTypeId: appointment.appointmentTypeId, slotStart: newSlotStart });

  try {
    return await withTransaction(async (session) => {
      const [reservation] = await SlotReservation.create([{
        clinicId,
        doctorId: appointment.doctorId,
        appointmentId: appointment._id,
        appointmentTypeId: appointment.appointmentTypeId,
        durationMinutes: appointment.durationMinutes,
        slotStart: newSlotStart,
        slotEnd: newSlotEnd,
        slotStartLocal: generated.startLocal,
        status: appointment.status === "confirmed" ? "confirmed" : "held",
        holdExpiresAt: appointment.status === "pending" ? DateTime.utc().plus({ minutes: env.PENDING_HOLD_MINUTES }).toJSDate() : undefined
      }], { session });
      await SlotReservation.updateOne({ _id: appointment.currentReservationId, clinicId }, { $set: { status: "released", releasedAt: new Date() } }, { session });
      const previousSlotStart = appointment.currentSlotStart;
      appointment.currentReservationId = reservation._id;
      appointment.currentSlotStart = newSlotStart;
      appointment.currentSlotEnd = newSlotEnd;
      appointment.appointmentTypeName = type?.name || appointment.appointmentTypeName;
      appointment.version += 1;
      await appointment.save({ session });
      await writeEvent({ appointment, eventType: "rescheduled", actor, previousState: appointment.status, newState: appointment.status, metadata: { previousSlotStart, newSlotStart, reason: data.reason }, session });
      return appointment;
    });
  } catch (err) {
    if (err?.code === 11000) throw new ConflictError("New slot is taken");
    throw err;
  }
}

export async function markOutcome(clinicId, id, outcome, actor) {
  if (actor.role !== "clinic_staff") throw new BadRequestError("Only clinic staff can update visit outcome");
  return withTransaction(async (session) => {
    const appointment = await Appointment.findOne({ _id: id, clinicId }).session(session);
    if (!appointment) throw new NotFoundError("Appointment not found");
    if (appointment.status !== "confirmed") throw new BadRequestError("Only confirmed appointments can be updated");
    if (appointment.currentSlotStart > new Date()) throw new BadRequestError("Appointment has not happened yet");
    appointment.status = outcome;
    appointment.version += 1;
    await appointment.save({ session });
    await writeEvent({ appointment, eventType: outcome, actor, previousState: "confirmed", newState: outcome, session });
    return appointment;
  });
}

