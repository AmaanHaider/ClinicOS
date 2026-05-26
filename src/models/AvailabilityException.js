import mongoose from "mongoose";
import { makeId } from "../utils/ids.js";

const windowSchema = new mongoose.Schema({ start: String, end: String }, { _id: false });

const schema = new mongoose.Schema({
  _id: { type: String, default: () => makeId("ex") },
  clinicId: { type: String, required: true },
  doctorId: { type: String, required: true },
  date: { type: String, required: true },
  type: { type: String, enum: ["block", "override", "additional"], required: true },
  windows: { type: [windowSchema], default: [] },
  reason: String,
  createdBy: String
}, { timestamps: true });

schema.index({ clinicId: 1, doctorId: 1, date: 1 }, { unique: true });

export const AvailabilityException = mongoose.model("AvailabilityException", schema);

