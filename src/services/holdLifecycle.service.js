/**
 * Hold lifecycle — lazy expiry of pending holds (no cron): on confirm failure, booking retry,
 * and bounded sweep during GET /slots. Writes expired event in transaction.
 */
import { Appointment, SlotReservation } from "../models/index.js";
import { withTransaction } from "../utils/transactions.js";
import { writeEvent } from "./event.service.js";

const systemActor = { id: "system", role: "system", name: "System" };

/** Mark held reservation + pending appointment as expired; write expired event. */
export async function expirePendingHold({ clinicId, appointmentId, reservationId, actor = systemActor, session }) {
  const now = new Date();
  const run = async (txnSession) => {
    const reservationFilter = reservationId
      ? { _id: reservationId, clinicId, status: "held", holdExpiresAt: { $lte: now } }
      : { clinicId, appointmentId, status: "held", holdExpiresAt: { $lte: now } };

    const expired = await SlotReservation.findOneAndUpdate(
      reservationFilter,
      { $set: { status: "expired" } },
      { new: true, session: txnSession }
    );
    if (!expired) return false;

    const appointment = await Appointment.findOneAndUpdate(
      { _id: expired.appointmentId || appointmentId, clinicId, status: "pending" },
      { $set: { status: "expired" }, $inc: { version: 1 } },
      { new: true, session: txnSession }
    );
    if (appointment) {
      await writeEvent({
        appointment,
        eventType: "expired",
        actor,
        previousState: "pending",
        newState: "expired",
        session: txnSession
      });
    }
    return true;
  };

  if (session) return run(session);
  return withTransaction(run);
}

export async function expireHoldBySlot({ clinicId, doctorId, slotStart, actor = systemActor }) {
  const now = new Date();
  const reservation = await SlotReservation.findOne({
    clinicId,
    doctorId,
    slotStart,
    status: "held",
    holdExpiresAt: { $lte: now }
  }).lean();
  if (!reservation?.appointmentId) return false;
  return expirePendingHold({
    clinicId,
    appointmentId: reservation.appointmentId,
    reservationId: reservation._id,
    actor
  });
}

/** Lazy sweep during GET /slots — at most `limit` expired holds per request. */
export async function expireStaleHoldsInRange({ clinicId, doctorId, rangeStart, rangeEnd, limit = 50, actor = systemActor }) {
  const now = new Date();
  const stale = await SlotReservation.find({
    clinicId,
    doctorId,
    status: "held",
    holdExpiresAt: { $lte: now },
    slotStart: { $lt: rangeEnd },
    slotEnd: { $gt: rangeStart }
  })
    .limit(limit)
    .select("_id appointmentId")
    .lean();

  for (const reservation of stale) {
    if (!reservation.appointmentId) continue;
    await expirePendingHold({
      clinicId,
      appointmentId: reservation.appointmentId,
      reservationId: reservation._id,
      actor
    });
  }
}
