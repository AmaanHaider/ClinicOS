/** Zod schemas for POST /auth/signup and /auth/login. */
import { z } from "zod";
import { envelope, id } from "./common.js";

const role = z.enum(["patient", "clinic_staff"]);

export const signupSchema = envelope({
  body: z.object({
    clinicId: id,
    email: z.string().email(),
    password: z.string().min(8),
    name: z.string().min(1),
    role
  })
});

export const loginSchema = envelope({
  body: z.object({
    clinicId: id,
    email: z.string().email(),
    password: z.string().min(1)
  })
});
