/**
 * Appointment type model — durationMinutes defines slot step size for GET /slots and bookings.
 */
import mongoose from "mongoose";
import { makeId } from "../utils/ids.js";

const schema = new mongoose.Schema({
  _id: { type: String, default: () => makeId("appttype") },
  clinicId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  durationMinutes: { type: Number, required: true },
  color: String,
  requiresSpecialisation: String,
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

schema.index({ clinicId: 1, isActive: 1 });

export const AppointmentType = mongoose.model("AppointmentType", schema);

