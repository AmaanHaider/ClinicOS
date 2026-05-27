/**
 * Doctor service — create/list doctors; requireDoctor guard used across booking and slots.
 */
import { AppointmentType, Doctor } from "../models/index.js";
import { BadRequestError, NotFoundError } from "../utils/errors.js";

export async function createDoctor(clinicId, data) {
  const count = await AppointmentType.countDocuments({ clinicId, _id: { $in: data.supportedAppointmentTypes || [] } });
  if (count !== (data.supportedAppointmentTypes || []).length) throw new BadRequestError("Appointment type does not belong to clinic");
  return Doctor.create({ ...data, clinicId });
}

export async function listDoctors(clinicId, query) {
  const filter = { clinicId, isActive: query.isActive ?? true };
  if (query.appointmentType) filter.supportedAppointmentTypes = query.appointmentType;
  return Doctor.find(filter).sort({ name: 1 }).lean();
}

export async function requireDoctor(clinicId, doctorId) {
  const doctor = await Doctor.findOne({ clinicId, _id: doctorId });
  if (!doctor) throw new NotFoundError("Doctor not found");
  return doctor;
}

