import { getSlots } from "../services/slot.service.js";

export async function slots(req, res, next) {
  try { res.json(await getSlots(req.clinicId, req.validated.query)); } catch (err) { next(err); }
}

