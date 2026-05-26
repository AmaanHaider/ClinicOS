import { AppointmentEvent } from "../models/AppointmentEvent.js";

export async function writeEvent({ appointment, appointmentId, clinicId, eventType, actor, previousState = null, newState = null, metadata = {}, session }) {
  const doc = appointment || {};
  const event = await AppointmentEvent.create([{
    appointmentId: appointmentId || doc._id,
    clinicId: clinicId || doc.clinicId,
    eventType,
    timestamp: new Date(),
    actor,
    previousState,
    newState: newState || doc.status,
    metadata
  }], { session });
  return event[0];
}

export async function history(clinicId, appointmentId) {
  return AppointmentEvent.find({ clinicId, appointmentId }).sort({ timestamp: 1 }).lean();
}

