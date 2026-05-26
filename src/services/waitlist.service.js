import { DateTime } from "luxon";
import { SlotOffer, WaitlistEntry } from "../models/index.js";
import { BadRequestError, GoneError, NotFoundError } from "../utils/errors.js";
import { withTransaction } from "../utils/transactions.js";
import { env } from "../config/env.js";
import { getSlots } from "./slot.service.js";
import { createAppointment } from "./booking.service.js";

export async function joinWaitlist(clinicId, data) {
  const slots = await getSlots(clinicId, { doctorId: data.doctorId, appointmentType: data.appointmentTypeId, from: data.targetDate, to: data.targetDate });
  if (slots.slots.length > 0) throw new BadRequestError("Slots are available. Book directly instead.");
  return WaitlistEntry.create({ ...data, clinicId, status: "waiting", joinedAt: new Date() });
}

export async function offerNextWaitlistPatient({ clinicId, doctorId, appointmentTypeId, targetDate, slotStart, slotEnd }) {
  const entry = await WaitlistEntry.findOne({ clinicId, doctorId, appointmentTypeId, targetDate, status: "waiting" }).sort({ urgencyFlag: -1, joinedAt: 1 });
  if (!entry) return null;
  return withTransaction(async (session) => {
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
}

export async function acceptOffer(clinicId, waitlistEntryId, actor) {
  const entry = await WaitlistEntry.findOne({ clinicId, _id: waitlistEntryId });
  if (!entry) throw new NotFoundError("Waitlist entry not found");
  const offer = await SlotOffer.findOne({ clinicId, waitlistEntryId, status: "offered" });
  if (!offer || offer.offerExpiresAt <= new Date()) throw new GoneError("Offer expired");
  const result = await createAppointment(clinicId, {
    doctorId: offer.doctorId,
    appointmentTypeId: offer.appointmentTypeId,
    slotStart: offer.slotStart.toISOString(),
    patientId: entry.patientId,
    patient: entry.patient
  }, actor);
  await withTransaction(async (session) => {
    await WaitlistEntry.updateOne({ _id: entry._id }, { $set: { status: "accepted" } }, { session });
    await SlotOffer.updateOne({ _id: offer._id }, { $set: { status: "accepted" } }, { session });
  });
  return result.appointment;
}

export async function listWaitlist(clinicId, doctorId) {
  return WaitlistEntry.find({ clinicId, doctorId, status: { $in: ["waiting", "offered"] } }).sort({ urgencyFlag: -1, joinedAt: 1 }).lean();
}

export async function removeWaitlist(clinicId, id) {
  const entry = await WaitlistEntry.findOneAndDelete({ clinicId, _id: id, status: { $in: ["waiting", "offered"] } });
  if (!entry) throw new NotFoundError("Waitlist entry not found");
  await SlotOffer.updateMany({ clinicId, waitlistEntryId: id, status: "offered" }, { $set: { status: "declined" } });
  return entry;
}

