/**
 * Doctor HTTP controller — create and list doctors for a clinic.
 */
import * as doctorService from "../services/doctor.service.js";

export async function createDoctor(req, res, next) {
  try { res.status(201).json(await doctorService.createDoctor(req.clinicId, req.validated.body)); } catch (err) { next(err); }
}

export async function listDoctors(req, res, next) {
  try { res.json({ data: await doctorService.listDoctors(req.clinicId, req.validated.query) }); } catch (err) { next(err); }
}

