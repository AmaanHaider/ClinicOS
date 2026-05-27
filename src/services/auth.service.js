import bcrypt from "bcryptjs";
import { Clinic, User } from "../models/index.js";
import { ConflictError, NotFoundError, UnauthorizedError } from "../utils/errors.js";
import { signToken } from "../utils/jwt.js";

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function userResponse(user) {
  return {
    _id: user._id,
    clinicId: user.clinicId,
    email: user.email,
    role: user.role,
    name: user.name,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function issueAccessToken(user) {
  return signToken({
    sub: user._id,
    clinicId: user.clinicId,
    role: user.role,
    name: user.name
  });
}

export async function signup(data) {
  const clinic = await Clinic.findById(data.clinicId).lean();
  if (!clinic) throw new NotFoundError("Clinic not found");

  const passwordHash = await bcrypt.hash(data.password, 12);
  try {
    const user = await User.create({
      clinicId: data.clinicId,
      email: normalizeEmail(data.email),
      passwordHash,
      role: data.role,
      name: data.name
    });
    return { accessToken: issueAccessToken(user), user: userResponse(user) };
  } catch (err) {
    if (err?.code === 11000) throw new ConflictError("Email already exists for this clinic");
    throw err;
  }
}

export async function login(data) {
  const user = await User.findOne({
    clinicId: data.clinicId,
    email: normalizeEmail(data.email),
    isActive: true
  });
  if (!user) throw new UnauthorizedError("Invalid clinic/email/password");

  const ok = await bcrypt.compare(data.password, user.passwordHash);
  if (!ok) throw new UnauthorizedError("Invalid clinic/email/password");

  user.lastLoginAt = new Date();
  await user.save();

  return { accessToken: issueAccessToken(user), user: userResponse(user) };
}
