import { DateTime } from "luxon";
import { SlotOffer, WaitlistEntry } from "../models/index.js";
import { BadRequestError, ConflictError, GoneError, NotFoundError } from "../utils/errors.js";
import { withTransaction } from "../utils/transactions.js";
import { env } from "../config/env.js";
import { getSlots } from "./slot.service.js";
import { createConfirmedAppointment } from "./booking.service.js";

function slotContext(entry, offer) {
  return {
    clinicId: entry.clinicId,
    doctorId: entry.doctorId,
    appointmentTypeId: entry.appointmentTypeId,
    targetDate: entry.targetDate,
    slotStart: offer?.slotStart ?? entry.offeredSlotStart,
    slotEnd: offer?.slotEnd
  };
}

export async function joinWaitlist(clinicId, data, actor) {
  const patientId = data.patientId || actor?.id;
  if (!patientId) throw new BadRequestError("patientId is required");

  const slots = await getSlots(clinicId, {
    doctorId: data.doctorId,
    appointmentType: data.appointmentTypeId,
    from: data.targetDate,
    to: data.targetDate
  });
  if (slots.slots.length > 0) {
    throw new BadRequestError("Slots are available. Book directly instead.");
  }

  try {
    return await WaitlistEntry.create({
      clinicId,
      doctorId: data.doctorId,
      appointmentTypeId: data.appointmentTypeId,
      targetDate: data.targetDate,
      patientId,
      patient: data.patient || {},
      urgencyFlag: data.urgencyFlag ?? false,
      status: "waiting",
      joinedAt: new Date()
    });
  } catch (err) {
    if (err?.code === 11000) throw new ConflictError("Patient is already on this waitlist");
    throw err;
  }
}

export async function offerNextWaitlistPatient({ clinicId, doctorId, appointmentTypeId, targetDate, slotStart, slotEnd }) {
  const entry = await WaitlistEntry.findOne({
    clinicId,
    doctorId,
    appointmentTypeId,
    targetDate,
    status: "waiting"
  }).sort({ urgencyFlag: -1, joinedAt: 1 });
  if (!entry) return null;

  try {
    return await withTransaction(async (session) => {
      const [offer] = await SlotOffer.create([{
        clinicId,
        doctorId,
        appointmentTypeId,
        waitlistEntryId: entry._id,
        slotStart,
        slotEnd,
        status: "offered",
        offerExpiresAt: DateTime.utc().plus({ minutes: env.WAITLIST_OFFER_MINUTES }).toJSDate()
      }], { session });

      entry.status = "offered";
      entry.offeredAt = new Date();
      entry.offerExpiresAt = offer.offerExpiresAt;
      entry.offeredSlotStart = slotStart;
      await entry.save({ session });
      return offer;
    });
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }
}

async function expireOfferAndAdvanceQueue({ entry, offer }) {
  const ctx = slotContext(entry, offer);
  await withTransaction(async (session) => {
    await SlotOffer.updateOne({ _id: offer._id, status: "offered" }, { $set: { status: "expired" } }, { session });
    await WaitlistEntry.updateOne({ _id: entry._id }, { $set: { status: "expired_offer" } }, { session });
  });
  await offerNextWaitlistPatient(ctx);
}

async function supersedeOfferAndAdvanceQueue({ entry, offer }) {
  const ctx = slotContext(entry, offer);
  await withTransaction(async (session) => {
    await SlotOffer.updateOne({ _id: offer._id, status: "offered" }, { $set: { status: "superseded" } }, { session });
    await WaitlistEntry.updateOne(
      { _id: entry._id },
      {
        $set: {
          status: "expired_offer",
          offeredAt: null,
          offerExpiresAt: null,
          offeredSlotStart: null
        }
      },
      { session }
    );
  });
  await offerNextWaitlistPatient(ctx);
}

export async function triggerWaitlistOfferAfterCancellation(appointment, clinicTimezone) {
  const targetDate = DateTime.fromJSDate(appointment.currentSlotStart, { zone: "utc" })
    .setZone(clinicTimezone)
    .toISODate();

  await offerNextWaitlistPatient({
    clinicId: appointment.clinicId,
    doctorId: appointment.doctorId,
    appointmentTypeId: appointment.appointmentTypeId,
    targetDate,
    slotStart: appointment.currentSlotStart,
    slotEnd: appointment.currentSlotEnd
  });
}

export async function acceptOffer(clinicId, waitlistEntryId, actor) {
  const entry = await WaitlistEntry.findOne({ clinicId, _id: waitlistEntryId });
  if (!entry) throw new NotFoundError("Waitlist entry not found");
  if (entry.status !== "offered") throw new BadRequestError("Waitlist entry is not in offered status");

  const offer = await SlotOffer.findOne({ clinicId, waitlistEntryId, status: "offered" });
  if (!offer) throw new NotFoundError("No active offer for this waitlist entry");

  const now = new Date();
  if (offer.offerExpiresAt <= now) {
    await expireOfferAndAdvanceQueue({ entry, offer });
    throw new GoneError("Offer has expired");
  }

  const ctx = slotContext(entry, offer);

  try {
    return await withTransaction(async (session) => {
      const appointment = await createConfirmedAppointment(
        clinicId,
        {
          doctorId: offer.doctorId,
          appointmentTypeId: offer.appointmentTypeId,
          slotStart: offer.slotStart.toISOString(),
          patientId: entry.patientId,
          patient: entry.patient
        },
        actor,
        session
      );

      await WaitlistEntry.updateOne({ _id: entry._id }, { $set: { status: "accepted" } }, { session });
      await SlotOffer.updateOne({ _id: offer._id }, { $set: { status: "accepted" } }, { session });
      return appointment;
    });
  } catch (err) {
    if (err?.code === 11000 || err instanceof ConflictError) {
      await supersedeOfferAndAdvanceQueue({ entry, offer });
      throw new ConflictError("This slot has just been taken. Please select another.");
    }
    throw err;
  }
}

export async function listWaitlist(clinicId, doctorId) {
  return WaitlistEntry.find({ clinicId, doctorId, status: { $in: ["waiting", "offered"] } })
    .sort({ urgencyFlag: -1, joinedAt: 1 })
    .lean();
}

export async function removeWaitlist(clinicId, id) {
  const entry = await WaitlistEntry.findOne({ clinicId, _id: id, status: { $in: ["waiting", "offered"] } });
  if (!entry) throw new NotFoundError("Waitlist entry not found");

  const offer = entry.status === "offered"
    ? await SlotOffer.findOne({ clinicId, waitlistEntryId: id, status: "offered" })
    : null;

  await WaitlistEntry.deleteOne({ _id: id });

  if (offer) {
    await SlotOffer.updateOne({ _id: offer._id }, { $set: { status: "declined" } });
    const ctx = slotContext(entry, offer);
    await offerNextWaitlistPatient(ctx);
  }

  return entry;
}
