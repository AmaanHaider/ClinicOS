/**
 * Auth HTTP controller — POST /auth/signup and /auth/login; returns JWT + user.
 */
import * as service from "../services/auth.service.js";

export async function signup(req, res, next) {
  try {
    const result = await service.signup(req.validated.body);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function login(req, res, next) {
  try {
    const result = await service.login(req.validated.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
}
