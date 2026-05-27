/**
 * Slot offer — time-limited waitlist offer for a freed slot; partial unique index per offered slot.
 */
import mongoose from "mongoose";
import { makeId } from "../utils/ids.js";

const schema = new mongoose.Schema({
  _id: { type: String, default: () => makeId("offer") },
  clinicId: { type: String, required: true },
  doctorId: { type: String, required: true },
  appointmentTypeId: { type: String, required: true },
  waitlistEntryId: { type: String, required: true },
  slotStart: { type: Date, required: true },
  slotEnd: { type: Date, required: true },
  status: { type: String, enum: ["offered", "accepted", "expired", "declined", "superseded"], default: "offered" },
  offerExpiresAt: Date
}, { timestamps: true });

schema.index(
  { clinicId: 1, doctorId: 1, appointmentTypeId: 1, slotStart: 1 },
  { unique: true, partialFilterExpression: { status: "offered" } }
);
schema.index({ clinicId: 1, waitlistEntryId: 1, status: 1 });

export const SlotOffer = mongoose.model("SlotOffer", schema);

