/**
 * JWT sign/verify — payload: sub, clinicId, role, name → req.actor in auth middleware.
 */
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { UnauthorizedError } from "./errors.js";

const ROLES = new Set(["patient", "clinic_staff", "system"]);

export function signToken({ sub, clinicId, role, name }) {
  return jwt.sign(
    { sub, clinicId, role, name: name || sub },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN }
  );
}

export function verifyToken(token) {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET);
    if (!payload?.sub || !payload?.clinicId || !payload?.role) {
      throw new UnauthorizedError("Invalid token payload");
    }
    if (!ROLES.has(payload.role)) {
      throw new UnauthorizedError("Invalid token role");
    }
    return {
      id: payload.sub,
      clinicId: payload.clinicId,
      role: payload.role,
      name: payload.name || payload.sub
    };
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    throw new UnauthorizedError("Invalid or expired token");
  }
}
