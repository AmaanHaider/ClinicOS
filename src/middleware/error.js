import { AppError, ErrorCodes } from "../utils/errors.js";

export function notFound(req, res) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: `Route not found: ${req.method} ${req.path}` } });
}

export function errorHandler(err, _req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err?.code === 11000) {
    return res.status(409).json({ error: { code: ErrorCodes.DUPLICATE_KEY, message: "Duplicate key conflict" } });
  }
  console.error(err);
  res.status(500).json({ error: { code: "INTERNAL_SERVER_ERROR", message: "Internal server error" } });
}

