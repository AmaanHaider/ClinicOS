import { ForbiddenError, UnauthorizedError } from "../utils/errors.js";

export function tenant(req, _res, next) {
  if (!req.actor?.clinicId) return next(new UnauthorizedError("No clinic context"));
  const routeClinicId = req.params.clinicId;
  if (routeClinicId && routeClinicId !== req.actor.clinicId) return next(new ForbiddenError("Clinic mismatch"));
  req.clinicId = req.actor.clinicId;
  next();
}

