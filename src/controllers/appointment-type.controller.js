import * as service from "../services/appointment-type.service.js";

export async function createAppointmentType(req, res, next) {
  try { res.status(201).json(await service.createAppointmentType(req.clinicId, req.validated.body)); } catch (err) { next(err); }
}

export async function listAppointmentTypes(req, res, next) {
  try { res.json({ data: await service.listAppointmentTypes(req.clinicId, req.query.includeInactive === "true") }); } catch (err) { next(err); }
}

export async function patchAppointmentType(req, res, next) {
  try { res.json(await service.patchAppointmentType(req.clinicId, req.validated.params.id, req.validated.body)); } catch (err) { next(err); }
}

