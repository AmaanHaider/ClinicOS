/** Zod schema for POST /clinics. */
import { z } from "zod";
import { envelope } from "./common.js";

export const createClinicSchema = envelope({
  body: z.object({
    name: z.string().min(1),
    timezone: z.string().min(1),
    address: z.object({}).passthrough().optional(),
    contactEmail: z.string().email().optional(),
    contactPhone: z.string().optional()
  })
});

