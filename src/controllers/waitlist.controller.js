/**
 * Waitlist HTTP controller — join queue, accept offer, list, remove entry.
 */
import * as service from "../services/waitlist.service.js";

export async function joinWaitlist(req, res, next) {
  try { res.status(201).json(await service.joinWaitlist(req.clinicId, req.validated.body, req.actor)); } catch (err) { next(err); }
}

export async function acceptOffer(req, res, next) {
  try { res.json(await service.acceptOffer(req.clinicId, req.validated.params.id, req.actor)); } catch (err) { next(err); }
}

export async function listWaitlist(req, res, next) {
  try { res.json({ data: await service.listWaitlist(req.clinicId, req.params.id) }); } catch (err) { next(err); }
}

export async function removeWaitlist(req, res, next) {
  try { res.json(await service.removeWaitlist(req.clinicId, req.validated.params.id, req.actor)); } catch (err) { next(err); }
}

