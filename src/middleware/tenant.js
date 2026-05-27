/**
 * Multi-tenancy guard — sets req.clinicId from JWT; rejects URL clinicId mismatch (403).
 */
import { ForbiddenError, UnauthorizedError } from "../utils/errors.js";

function clinicIdFromPath(req) {
  if (req.params?.clinicId) return req.params.clinicId;
  const match = req.originalUrl.match(/\/clinics\/([^/?]+)/);
  return match?.[1];
}

export function tenant(req, _res, next) {
  if (!req.actor?.clinicId) return next(new UnauthorizedError("No clinic context"));
  const routeClinicId = clinicIdFromPath(req);
  if (routeClinicId && routeClinicId !== req.actor.clinicId) {
    return next(new ForbiddenError("Clinic mismatch"));
  }
  req.clinicId = req.actor.clinicId;
  next();
}
