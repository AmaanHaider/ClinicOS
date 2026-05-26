import { z } from "zod";
import { envelope, id } from "./common.js";

export const createDoctorSchema = envelope({
  params: z.object({ clinicId: id }),
  body: z.object({
    name: z.string().min(1),
    specialisation: z.string().optional(),
    email: z.string().email().optional(),
    supportedAppointmentTypes: z.array(id).default([])
  })
});

export const listDoctorsSchema = envelope({
  params: z.object({ clinicId: id }),
  query: z.object({
    isActive: z.coerce.boolean().optional(),
    appointmentType: z.string().optional(),
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(100).optional()
  })
});

