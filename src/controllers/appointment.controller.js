import { Appointment } from "../models/Appointment.js";
import { BadRequestError, NotFoundError } from "../utils/errors.js";
import * as booking from "../services/booking.service.js";
import { history } from "../services/event.service.js";

export async function createAppointment(req, res, next) {
  try {
    const result = await booking.createAppointment(req.clinicId, req.validated.body, req.actor);
    res.status(result.statusCode).json(result.appointment);
  } catch (err) { next(err); }
}

export async function confirmAppointment(req, res, next) {
  try { res.json(await booking.confirmAppointment(req.clinicId, req.validated.params.id, req.actor)); } catch (err) { next(err); }
}

export async function rescheduleAppointment(req, res, next) {
  try { res.json(await booking.rescheduleAppointment(req.clinicId, req.validated.params.id, req.validated.body, req.actor)); } catch (err) { next(err); }
}

export async function cancelAppointment(req, res, next) {
  try { res.json(await booking.cancelAppointment(req.clinicId, req.validated.params.id, req.validated.body, req.actor)); } catch (err) { next(err); }
}

export async function noShow(req, res, next) {
  try { res.json(await booking.markOutcome(req.clinicId, req.validated.params.id, "no_show", req.actor)); } catch (err) { next(err); }
}

export async function complete(req, res, next) {
  try { res.json(await booking.markOutcome(req.clinicId, req.validated.params.id, "completed", req.actor)); } catch (err) { next(err); }
}

export async function getAppointment(req, res, next) {
  try {
    const appt = await Appointment.findOne({ _id: req.validated.params.id, clinicId: req.clinicId });
    if (!appt) throw new NotFoundError("Appointment not found");
    res.json(appt);
  } catch (err) { next(err); }
}

export async function appointmentHistory(req, res, next) {
  try {
    const appt = await Appointment.findOne({ _id: req.validated.params.id, clinicId: req.clinicId }).lean();
    if (!appt) throw new NotFoundError("Appointment not found");
    res.json({ appointmentId: appt._id, events: await history(req.clinicId, appt._id) });
  } catch (err) { next(err); }
}

export async function listAppointments(req, res, next) {
  try {
    const q = req.validated.query;
    if (!q.date && !(q.from && q.to) && !q.patientId) throw new BadRequestError("Provide date, from/to, or patientId");
    const filter = { clinicId: req.clinicId };
    if (q.doctorId) filter.doctorId = q.doctorId;
    if (q.status) filter.status = q.status;
    if (q.patientId) filter.patientId = q.patientId;
    if (q.date) {
      const start = new Date(`${q.date}T00:00:00.000Z`);
      const end = new Date(`${q.date}T23:59:59.999Z`);
      filter.currentSlotStart = { $gte: start, $lte: end };
    } else if (q.from && q.to) {
      filter.currentSlotStart = { $gte: new Date(q.from), $lte: new Date(q.to) };
    }
    if (q.after) filter._id = { $gt: q.after };
    const limit = q.limit || 50;
    const data = await Appointment.find(filter).sort({ _id: 1 }).limit(limit + 1).lean();
    res.json({ data: data.slice(0, limit), nextCursor: data.length > limit ? data[limit]._id : null });
  } catch (err) { next(err); }
}

