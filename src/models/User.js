import mongoose from "mongoose";
import { makeId } from "../utils/ids.js";

const ROLES = ["patient", "clinic_staff"];

const schema = new mongoose.Schema({
  _id: { type: String, default: () => makeId("user") },
  clinicId: { type: String, required: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ROLES, required: true },
  name: { type: String, required: true },
  isActive: { type: Boolean, default: true },
  lastLoginAt: Date
}, { timestamps: true });

schema.index({ clinicId: 1, email: 1 }, { unique: true });
schema.index({ clinicId: 1, role: 1, isActive: 1 });
schema.index({ clinicId: 1, _id: 1 });

export const User = mongoose.model("User", schema);
