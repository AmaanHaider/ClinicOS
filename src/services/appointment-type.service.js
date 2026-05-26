import { AppointmentType } from "../models/AppointmentType.js";
import { NotFoundError } from "../utils/errors.js";

export async function createAppointmentType(clinicId, data) {
  return AppointmentType.create({ ...data, clinicId, isActive: true });
}

export async function listAppointmentTypes(clinicId, includeInactive = false) {
  const filter = { clinicId };
  if (!includeInactive) filter.isActive = true;
  return AppointmentType.find(filter).sort({ name: 1 }).lean();
}

export async function patchAppointmentType(clinicId, id, data) {
  const updated = await AppointmentType.findOneAndUpdate({ clinicId, _id: id }, data, { new: true });
  if (!updated) throw new NotFoundError("Appointment type not found");
  return updated;
}

export async function requireAppointmentType(clinicId, id) {
  const type = await AppointmentType.findOne({ clinicId, _id: id });
  if (!type) throw new NotFoundError("Appointment type not found");
  return type;
}

