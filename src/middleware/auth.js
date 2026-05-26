import { UnauthorizedError } from "../utils/errors.js";
import { verifyToken } from "../utils/jwt.js";

function bearerToken(req) {
  const header = req.header("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}

function actorFromDevHeaders(req) {
  const clinicId = req.header("x-clinic-id");
  if (!clinicId) return null;
  return {
    id: req.header("x-actor-id") || "dev_actor",
    role: req.header("x-actor-role") || "clinic_staff",
    name: req.header("x-actor-name") || "Development User",
    clinicId
  };
}

export function auth(req, _res, next) {
  const token = bearerToken(req);
  if (token) {
    try {
      req.actor = verifyToken(token);
      return next();
    } catch (err) {
      return next(err);
    }
  }

  const production = process.env.NODE_ENV === "production";
  if (!production) {
    const actor = actorFromDevHeaders(req);
    if (actor) {
      req.actor = actor;
      return next();
    }
  }

  return next(new UnauthorizedError(
    production
      ? "Missing or invalid Authorization Bearer token"
      : "Missing Authorization Bearer token or x-clinic-id dev headers"
  ));
}
