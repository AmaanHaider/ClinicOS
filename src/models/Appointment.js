import mongoose from "mongoose";
import { makeId } from "../utils/ids.js";

const schema = new mongoose.Schema({
  _id: { type: String, default: () => makeId("appt") },
  clinicId: { type: String, required: true },
  doctorId: { type: String, required: true },
  patientId: String,
  appointmentTypeId: { type: String, required: true },
  appointmentTypeName: String,
  durationMinutes: { type: Number, required: true },
  currentReservationId: String,
  currentSlotStart: Date,
  currentSlotEnd: Date,
  status: { type: String, enum: ["pending", "confirmed", "cancelled", "expired", "no_show", "completed"], required: true },
  version: { type: Number, default: 1 },
  idempotencyKey: String,
  patient: { type: Object, default: {} },
  notes: String,
  cancelledBy: String,
  cancellationReason: String
}, { timestamps: true });

schema.index({ clinicId: 1, doctorId: 1, status: 1, currentSlotStart: 1 });
schema.index({ clinicId: 1, status: 1, currentSlotStart: 1 });
schema.index({ clinicId: 1, patientId: 1, currentSlotStart: -1 });
schema.index({ clinicId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });

export const Appointment = mongoose.model("Appointment", schema);

