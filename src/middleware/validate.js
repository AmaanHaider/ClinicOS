import { BadRequestError } from "../utils/errors.js";

export function validate(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse({ body: req.body, query: req.query, params: req.params });
    if (!result.success) return next(new BadRequestError("Validation failed", result.error.flatten()));
    req.validated = result.data;
    next();
  };
}

