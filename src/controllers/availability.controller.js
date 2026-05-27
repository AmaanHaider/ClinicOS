/**
 * Availability HTTP controller — weekly template, date exceptions, dry-run validate.
 */
import * as service from "../services/availability.service.js";

export async function putAvailability(req, res, next) {
  try { res.json(await service.putAvailability(req.clinicId, req.validated.params.id, req.validated.body.weeklyTemplate)); } catch (err) { next(err); }
}

export async function getAvailability(req, res, next) {
  try { res.json(await service.getAvailability(req.clinicId, req.params.id)); } catch (err) { next(err); }
}

export async function upsertException(req, res, next) {
  try { res.status(201).json(await service.upsertException(req.clinicId, req.validated.params.id, req.validated.body, req.actor)); } catch (err) { next(err); }
}

export async function deleteException(req, res, next) {
  try { res.json(await service.deleteException(req.clinicId, req.validated.params.id, req.validated.params.date)); } catch (err) { next(err); }
}

export async function validateAvailability(req, res, next) {
  try { res.json(await service.validateAvailabilityChange(req.clinicId, req.validated.params.id, req.validated.body.proposedTemplate, req.validated.body.dateRange)); } catch (err) { next(err); }
}

