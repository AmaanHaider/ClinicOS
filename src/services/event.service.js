/**
 * Event log service — append-only appointmentEvents; history API; replay/reconcile helpers.
 */
import { Appointment } from "../models/Appointment.js";
import { AppointmentEvent } from "../models/AppointmentEvent.js";

/** Append one audit row — pass session when inside withTransaction. */
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

/** Replay events to derive status (and slot after reschedule) — used in tests/reconcile. */
export function deriveAppointmentFromEvents(events) {
  const sorted = [...events].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const derived = { status: null, currentSlotStart: null };

  for (const event of sorted) {
    switch (event.eventType) {
      case "created":
        derived.status = event.newState;
        break;
      case "confirmed":
        derived.status = "confirmed";
        break;
      case "rescheduled":
        derived.status = event.newState;
        if (event.metadata?.newSlotStart) {
          derived.currentSlotStart = new Date(event.metadata.newSlotStart);
        }
        break;
      case "cancelled":
      case "expired":
      case "no_show":
      case "completed":
        derived.status = event.newState;
        break;
      default:
        break;
    }
  }

  return derived;
}

export async function reconcileAppointment(clinicId, appointmentId) {
  const appointment = await Appointment.findOne({ clinicId, _id: appointmentId }).lean();
  if (!appointment) return { matches: false, appointment: null, derived: null, events: [] };

  const events = await history(clinicId, appointmentId);
  const derived = deriveAppointmentFromEvents(events);
  const statusMatches = derived.status === appointment.status;
  const slotMatches = !derived.currentSlotStart
    || !appointment.currentSlotStart
    || new Date(derived.currentSlotStart).getTime() === new Date(appointment.currentSlotStart).getTime();

  return {
    matches: statusMatches && slotMatches,
    appointment,
    derived,
    events
  };
}
