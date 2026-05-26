import { UnauthorizedError } from "../utils/errors.js";

export function auth(req, _res, next) {
  const clinicId = req.header("x-clinic-id");
  if (!clinicId) return next(new UnauthorizedError("Missing x-clinic-id header"));
  req.actor = {
    id: req.header("x-actor-id") || "dev_actor",
    role: req.header("x-actor-role") || "clinic_staff",
    name: req.header("x-actor-name") || "Development User",
    clinicId
  };
  next();
}

