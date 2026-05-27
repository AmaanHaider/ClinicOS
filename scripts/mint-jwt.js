#!/usr/bin/env node
/**
 * Print a JWT for curl / Swagger / manual testing.
 *
 * Usage:
 *   npm run mint-jwt
 *   npm run mint-jwt -- clinic_india patient_demo patient
 *   npm run mint-jwt -- clinic_india staff_demo clinic_staff
 */
import "../src/config/env.js";
import { signToken } from "../src/utils/jwt.js";

const [clinicId = "clinic_india", sub = "patient_demo", role = "patient"] = process.argv.slice(2);

const token = signToken({ sub, clinicId, role, name: sub });
console.log(token);
