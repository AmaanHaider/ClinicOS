/**
 * Availability template — weekly recurring windows (MON–SUN). One active template per doctor.
 */
import mongoose from "mongoose";
import { makeId } from "../utils/ids.js";

const windowSchema = new mongoose.Schema({ start: String, end: String }, { _id: false });

const schema = new mongoose.Schema({
  _id: { type: String, default: () => makeId("avail") },
  clinicId: { type: String, required: true },
  doctorId: { type: String, required: true },
  weeklyTemplate: {
    MON: { type: [windowSchema], default: [] },
    TUE: { type: [windowSchema], default: [] },
    WED: { type: [windowSchema], default: [] },
    THU: { type: [windowSchema], default: [] },
    FRI: { type: [windowSchema], default: [] },
    SAT: { type: [windowSchema], default: [] },
    SUN: { type: [windowSchema], default: [] }
  },
  version: { type: Number, default: 1 },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

schema.index({ clinicId: 1, doctorId: 1, isActive: 1 }, { unique: true, partialFilterExpression: { isActive: true } });

export const AvailabilityTemplate = mongoose.model("AvailabilityTemplate", schema);

