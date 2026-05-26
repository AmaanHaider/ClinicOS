import { Clinic } from "../models/Clinic.js";
import { assertIanaTimezone } from "../utils/timezone.js";

export async function createClinic(data) {
  assertIanaTimezone(data.timezone);
  return Clinic.create(data);
}

