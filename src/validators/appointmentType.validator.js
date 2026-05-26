import { z } from "zod";
import { envelope, id } from "./common.js";

export const createAppointmentTypeSchema = envelope({
  params: z.object({ clinicId: id }),
  body: z.object({
    name: z.string().min(1),
    durationMinutes: z.number().int().positive().max(480),
    color: z.string().optional(),
    requiresSpecialisation: z.string().nullable().optional()
  })
});

export const patchAppointmentTypeSchema = envelope({
  params: z.object({ id }),
  body: z.object({
    name: z.string().min(1).optional(),
    durationMinutes: z.number().int().positive().max(480).optional(),
    color: z.string().optional(),
    requiresSpecialisation: z.string().nullable().optional(),
    isActive: z.boolean().optional()
  })
});

