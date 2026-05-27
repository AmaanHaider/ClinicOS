/**
 * Clinic model — tenant root; timezone (IANA) used for all local→UTC slot boundaries.
 */
import mongoose from "mongoose";
import { makeId } from "../utils/ids.js";

const schema = new mongoose.Schema({
  _id: { type: String, default: () => makeId("clinic") },
  name: { type: String, required: true },
  timezone: { type: String, required: true },
  address: { type: Object, default: {} },
  contactEmail: String,
  contactPhone: String,
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

export const Clinic = mongoose.model("Clinic", schema);

