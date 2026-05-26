import mongoose from "mongoose";
import { makeId } from "../utils/ids.js";

const schema = new mongoose.Schema({
  _id: { type: String, default: () => makeId("res") },
  clinicId: { type: String, required: true },
  doctorId: { type: String, required: true },
  appointmentId: String,
  appointmentTypeId: { type: String, required: true },
  durationMinutes: { type: Number, required: true },
  slotStart: { type: Date, required: true },
  slotEnd: { type: Date, required: true },
  slotStartLocal: String,
  status: { type: String, enum: ["held", "confirmed", "released", "expired"], required: true },
  holdExpiresAt: Date,
  releasedAt: Date
}, { timestamps: true });

schema.index(
  { clinicId: 1, doctorId: 1, slotStart: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ["held", "confirmed"] } } }
);
schema.index({ clinicId: 1, doctorId: 1, status: 1, slotStart: 1, slotEnd: 1 });
schema.index({ clinicId: 1, status: 1, holdExpiresAt: 1 });

export const SlotReservation = mongoose.model("SlotReservation", schema);

