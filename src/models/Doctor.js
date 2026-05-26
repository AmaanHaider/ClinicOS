import mongoose from "mongoose";
import { makeId } from "../utils/ids.js";

const schema = new mongoose.Schema({
  _id: { type: String, default: () => makeId("dr") },
  clinicId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  specialisation: String,
  email: String,
  supportedAppointmentTypes: [{ type: String }],
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

schema.index({ clinicId: 1, isActive: 1 });
schema.index({ clinicId: 1, _id: 1 });

export const Doctor = mongoose.model("Doctor", schema);

