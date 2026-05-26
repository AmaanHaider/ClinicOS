export class AppError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class BadRequestError extends AppError {
  constructor(message, details) { super(400, "BAD_REQUEST", message, details); }
}
export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") { super(401, "UNAUTHORIZED", message); }
}
export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") { super(403, "FORBIDDEN", message); }
}
export class NotFoundError extends AppError {
  constructor(message = "Not found") { super(404, "NOT_FOUND", message); }
}
export class ConflictError extends AppError {
  constructor(message, details) { super(409, "CONFLICT", message, details); }
}
export class GoneError extends AppError {
  constructor(message, details) { super(410, "GONE", message, details); }
}

