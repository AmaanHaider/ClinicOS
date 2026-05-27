import { DateTime } from "luxon";
import { Appointment, AppointmentType, Clinic, SlotReservation } from "../models/index.js";
import { BadRequestError, ConflictError, GoneError, NotFoundError } from "../utils/errors.js";
import { parseUtcDateTime } from "../utils/timezone.js";
import { withTransaction } from "../utils/transactions.js";
import { requireDoctor } from "./doctor.service.js";
import { requireAppointmentType } from "./appointment-type.service.js";
import { assertGeneratedSlot, assertNoActiveReservationOverlap } from "./slot.service.js";
import { writeEvent } from "./event.service.js";
import { expireHoldBySlot, expirePendingHold } from "./holdLifecycle.service.js";
import { env } from "../config/env.js";

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
  await assertNoActiveReservationOverlap(clinicId, { doctorId: doctor._id, slotStart, slotEnd });
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
      const expired = await expireHoldBySlot({ clinicId, doctorId: doctor._id, slotStart, actor });
      if (expired) return createAppointment(clinicId, data, actor, false);
    }
    if (err?.code === 11000) throw new ConflictError("This slot has just been taken. Please select another.", { slotStart });
    throw err;
  }
}

export async function createConfirmedAppointment(clinicId, data, actor, session) {
  const slotStart = parseUtcDateTime(data.slotStart).toJSDate();
  if (slotStart <= new Date()) throw new BadRequestError("slotStart must be in the future");
  const doctor = await requireDoctor(clinicId, data.doctorId);
  const type = await requireAppointmentType(clinicId, data.appointmentTypeId);
  if (!doctor.supportedAppointmentTypes.includes(type._id)) {
    throw new BadRequestError("Appointment type not supported by doctor");
  }
  const slotEnd = DateTime.fromJSDate(slotStart, { zone: "utc" }).plus({ minutes: type.durationMinutes }).toJSDate();
  await assertNoActiveReservationOverlap(clinicId, { doctorId: doctor._id, slotStart, slotEnd });
  const generated = await assertGeneratedSlot(clinicId, { doctorId: doctor._id, appointmentTypeId: type._id, slotStart });

  const run = async (txnSession) => {
    const [reservation] = await SlotReservation.create([{
      clinicId,
      doctorId: doctor._id,
      appointmentTypeId: type._id,
      durationMinutes: type.durationMinutes,
      slotStart,
      slotEnd,
      slotStartLocal: generated.startLocal,
      status: "confirmed"
    }], { session: txnSession });

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
      status: "confirmed",
      patient: data.patient || {},
      notes: data.notes
    }], { session: txnSession });

    reservation.appointmentId = appointment._id;
    await reservation.save({ session: txnSession });
    await writeEvent({
      appointment,
      eventType: "created",
      actor,
      previousState: null,
      newState: "confirmed",
      session: txnSession
    });
    return appointment;
  };

  if (session) return run(session);
  try {
    return await withTransaction(run);
  } catch (err) {
    if (err?.code === 11000) throw new ConflictError("This slot has just been taken. Please select another.", { slotStart });
    throw err;
  }
}

export async function confirmAppointment(clinicId, id, actor) {
  const now = new Date();
  const existing = await Appointment.findOne({ _id: id, clinicId });
  if (!existing) throw new NotFoundError("Appointment not found");
  if (existing.status !== "pending") throw new ConflictError("Appointment is not pending");

  const reservation = await SlotReservation.findOne({ _id: existing.currentReservationId, clinicId });
  if (!reservation || reservation.status !== "held" || reservation.holdExpiresAt <= now) {
    await expirePendingHold({ clinicId, appointmentId: id, reservationId: reservation?._id, actor });
    throw new GoneError("Your booking hold has expired. Please start again.");
  }

  try {
    return await withTransaction(async (session) => {
      const appointment = await Appointment.findOneAndUpdate(
        { _id: id, clinicId, status: "pending", version: existing.version },
        { $set: { status: "confirmed" }, $inc: { version: 1 } },
        { new: true, session }
      );
      if (!appointment) throw new ConflictError("Appointment was already updated");

      const confirmedReservation = await SlotReservation.findOneAndUpdate(
        { _id: reservation._id, clinicId, status: "held", holdExpiresAt: { $gt: now } },
        { $set: { status: "confirmed" }, $unset: { holdExpiresAt: 1 } },
        { new: true, session }
      );
      if (!confirmedReservation) throw new GoneError("Your booking hold has expired. Please start again.");

      await writeEvent({ appointment, eventType: "confirmed", actor, previousState: "pending", newState: "confirmed", session });
      return appointment;
    });
  } catch (err) {
    if (err instanceof GoneError) {
      await expirePendingHold({ clinicId, appointmentId: id, reservationId: reservation._id, actor });
    }
    throw err;
  }
}

export async function cancelAppointment(clinicId, id, data, actor) {
  const appointment = await withTransaction(async (session) => {
    const existing = await Appointment.findOne({ _id: id, clinicId }).session(session);
    if (!existing) throw new NotFoundError("Appointment not found");
    if (!["pending", "confirmed"].includes(existing.status)) {
      if (["cancelled", "completed", "no_show", "expired"].includes(existing.status)) {
        throw new ConflictError("Appointment was already updated");
      }
      throw new BadRequestError("Appointment cannot be cancelled");
    }

    const previousState = existing.status;
    const updated = await Appointment.findOneAndUpdate(
      { _id: id, clinicId, status: { $in: ["pending", "confirmed"] }, version: existing.version },
      {
        $set: { status: "cancelled", cancelledBy: data.cancelledBy, cancellationReason: data.reason },
        $inc: { version: 1 }
      },
      { new: true, session }
    );
    if (!updated) throw new ConflictError("Appointment was already updated");

    await SlotReservation.updateOne(
      { _id: existing.currentReservationId, clinicId, status: { $in: ["held", "confirmed"] } },
      { $set: { status: "released", releasedAt: new Date() } },
      { session }
    );
    await writeEvent({ appointment: updated, eventType: "cancelled", actor, previousState, newState: "cancelled", metadata: data, session });
    return updated;
  });

  const clinic = await Clinic.findById(clinicId).lean();
  if (clinic) {
    const { triggerWaitlistOfferAfterCancellation } = await import("./waitlist.service.js");
    await triggerWaitlistOfferAfterCancellation(appointment, clinic.timezone);
  }
  return appointment;
}

export async function rescheduleAppointment(clinicId, id, data, actor) {
  const preview = await Appointment.findOne({ _id: id, clinicId });
  if (!preview) throw new NotFoundError("Appointment not found");
  if (!["pending", "confirmed"].includes(preview.status)) throw new BadRequestError("Appointment cannot be rescheduled");
  const newSlotStart = parseUtcDateTime(data.newSlotStart).toJSDate();
  if (newSlotStart.getTime() === preview.currentSlotStart.getTime()) throw new BadRequestError("New slot is the same as current slot");
  const type = await AppointmentType.findOne({ clinicId, _id: preview.appointmentTypeId });
  const newSlotEnd = DateTime.fromJSDate(newSlotStart, { zone: "utc" }).plus({ minutes: preview.durationMinutes }).toJSDate();
  await assertNoActiveReservationOverlap(clinicId, {
    doctorId: preview.doctorId,
    slotStart: newSlotStart,
    slotEnd: newSlotEnd,
    excludeReservationId: preview.currentReservationId
  });
  const generated = await assertGeneratedSlot(clinicId, { doctorId: preview.doctorId, appointmentTypeId: preview.appointmentTypeId, slotStart: newSlotStart });

  try {
    return await withTransaction(async (session) => {
      const existing = await Appointment.findOne({ _id: id, clinicId }).session(session);
      if (!existing) throw new NotFoundError("Appointment not found");
      if (!["pending", "confirmed"].includes(existing.status)) throw new BadRequestError("Appointment cannot be rescheduled");
      if (newSlotStart.getTime() === existing.currentSlotStart.getTime()) throw new BadRequestError("New slot is the same as current slot");

      const previousSlotStart = existing.currentSlotStart;
      const previousReservationId = existing.currentReservationId;
      const status = existing.status;

      const claimed = await Appointment.findOneAndUpdate(
        { _id: id, clinicId, status: { $in: ["pending", "confirmed"] }, version: existing.version },
        { $inc: { version: 1 } },
        { new: true, session }
      );
      if (!claimed) throw new ConflictError("Appointment was already updated");

      const [reservation] = await SlotReservation.create([{
        clinicId,
        doctorId: existing.doctorId,
        appointmentId: existing._id,
        appointmentTypeId: existing.appointmentTypeId,
        durationMinutes: existing.durationMinutes,
        slotStart: newSlotStart,
        slotEnd: newSlotEnd,
        slotStartLocal: generated.startLocal,
        status: status === "confirmed" ? "confirmed" : "held",
        holdExpiresAt: status === "pending" ? DateTime.utc().plus({ minutes: env.PENDING_HOLD_MINUTES }).toJSDate() : undefined
      }], { session });

      await Appointment.updateOne(
        { _id: id, clinicId },
        {
          $set: {
            currentReservationId: reservation._id,
            currentSlotStart: newSlotStart,
            currentSlotEnd: newSlotEnd,
            appointmentTypeName: type?.name || existing.appointmentTypeName
          }
        },
        { session }
      );

      await SlotReservation.updateOne(
        { _id: previousReservationId, clinicId, status: { $in: ["held", "confirmed"] } },
        { $set: { status: "released", releasedAt: new Date() } },
        { session }
      );

      const appointment = await Appointment.findOne({ _id: id, clinicId }).session(session);
      await writeEvent({
        appointment,
        eventType: "rescheduled",
        actor,
        previousState: status,
        newState: status,
        metadata: { previousSlotStart, newSlotStart, reason: data.reason },
        session
      });
      return appointment;
    });
  } catch (err) {
    if (err?.code === 11000) throw new ConflictError("New slot is taken");
    throw err;
  }
}

export async function markOutcome(clinicId, id, outcome, actor) {
  if (actor.role !== "clinic_staff") throw new BadRequestError("Only clinic staff can update visit outcome");
  const now = new Date();
  return withTransaction(async (session) => {
    const existing = await Appointment.findOne({ _id: id, clinicId }).session(session);
    if (!existing) throw new NotFoundError("Appointment not found");
    if (existing.status !== "confirmed") {
      if (["no_show", "completed", "cancelled", "expired"].includes(existing.status)) {
        throw new ConflictError("Appointment was already updated");
      }
      throw new BadRequestError("Only confirmed appointments can be updated");
    }
    if (existing.currentSlotStart > now) throw new BadRequestError("Appointment has not happened yet");

    const appointment = await Appointment.findOneAndUpdate(
      { _id: id, clinicId, status: "confirmed", version: existing.version, currentSlotStart: { $lte: now } },
      { $set: { status: outcome }, $inc: { version: 1 } },
      { new: true, session }
    );
    if (!appointment) {
      const current = await Appointment.findOne({ _id: id, clinicId }).session(session);
      if (current?.currentSlotStart > now) throw new BadRequestError("Appointment has not happened yet");
      throw new ConflictError("Appointment was already updated");
    }

    await writeEvent({ appointment, eventType: outcome, actor, previousState: "confirmed", newState: outcome, session });
    return appointment;
  });
}

