/**
 * Slots HTTP controller — GET /slots; ensures query clinicId matches JWT tenant.
 */
import { ForbiddenError } from "../utils/errors.js";
import { getSlots } from "../services/slot.service.js";

export async function slots(req, res, next) {
  try {
    if (req.validated.query.clinicId !== req.clinicId) {
      throw new ForbiddenError("Clinic mismatch");
    }
    res.json(await getSlots(req.clinicId, req.validated.query));
  } catch (err) {
    next(err);
  }
}

