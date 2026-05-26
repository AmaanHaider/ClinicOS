import mongoose from "mongoose";
import { makeId } from "../utils/ids.js";

const schema = new mongoose.Schema({
  _id: { type: String, default: () => makeId("evt") },
  appointmentId: { type: String, required: true },
  clinicId: { type: String, required: true },
  eventType: { type: String, enum: ["created", "confirmed", "rescheduled", "cancelled", "no_show", "completed", "expired"], required: true },
  timestamp: { type: Date, default: Date.now },
  actor: { type: Object, required: true },
  previousState: String,
  newState: String,
  metadata: { type: Object, default: {} }
}, { versionKey: false });

schema.index({ appointmentId: 1, timestamp: 1 });
schema.index({ clinicId: 1, timestamp: -1 });

export const AppointmentEvent = mongoose.model("AppointmentEvent", schema);

