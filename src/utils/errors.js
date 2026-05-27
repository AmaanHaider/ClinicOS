/**
 * HTTP error types and stable API codes (SLOT_TAKEN, HOLD_EXPIRED, VERSION_CONFLICT, etc.).
 */
export const ErrorCodes = {
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  SLOT_TAKEN: "SLOT_TAKEN",
  VERSION_CONFLICT: "VERSION_CONFLICT",
  GONE: "GONE",
  HOLD_EXPIRED: "HOLD_EXPIRED",
  OFFER_EXPIRED: "OFFER_EXPIRED",
  DUPLICATE_KEY: "DUPLICATE_KEY"
};

export class AppError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class BadRequestError extends AppError {
  constructor(message, details) {
    super(400, ErrorCodes.BAD_REQUEST, message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(401, ErrorCodes.UNAUTHORIZED, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(403, ErrorCodes.FORBIDDEN, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, ErrorCodes.NOT_FOUND, message);
  }
}

export class ConflictError extends AppError {
  constructor(message, details, code = ErrorCodes.CONFLICT) {
    super(409, code, message, details);
  }
}

export class GoneError extends AppError {
  constructor(message, details, code = ErrorCodes.GONE) {
    super(410, code, message, details);
  }
}
