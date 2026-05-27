/**
 * Waitlist entry — patient queue for a fully-booked doctor/day; status waiting | offered | accepted.
 */
import mongoose from "mongoose";
import { makeId } from "../utils/ids.js";

const schema = new mongoose.Schema({
  _id: { type: String, default: () => makeId("wait") },
  clinicId: { type: String, required: true },
  doctorId: { type: String, required: true },
  appointmentTypeId: { type: String, required: true },
  targetDate: { type: String, required: true },
  patientId: String,
  patient: { type: Object, default: {} },
  urgencyFlag: { type: Boolean, default: false },
  status: { type: String, enum: ["waiting", "offered", "accepted", "expired_offer"], default: "waiting" },
  joinedAt: { type: Date, default: Date.now },
  offeredAt: Date,
  offerExpiresAt: Date,
  offeredSlotStart: Date
}, { timestamps: true });

schema.index({ clinicId: 1, doctorId: 1, targetDate: 1, appointmentTypeId: 1, status: 1, urgencyFlag: -1, joinedAt: 1 });
schema.index({ clinicId: 1, patientId: 1, status: 1 });
schema.index({ clinicId: 1, doctorId: 1, targetDate: 1, appointmentTypeId: 1, patientId: 1 }, { unique: true });

export const WaitlistEntry = mongoose.model("WaitlistEntry", schema);

