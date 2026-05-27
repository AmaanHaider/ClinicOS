import { UnauthorizedError } from "../utils/errors.js";
import { verifyToken } from "../utils/jwt.js";

function bearerToken(req) {
  const header = req.header("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}

export function auth(req, _res, next) {
  const token = bearerToken(req);
  if (!token) {
    return next(new UnauthorizedError("Missing or invalid Authorization Bearer token"));
  }
  try {
    req.actor = verifyToken(token);
    return next();
  } catch (err) {
    return next(err);
  }
}
