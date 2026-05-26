import { z } from "zod";
import { envelope, id, isoDateTime } from "./common.js";

export const createAppointmentSchema = envelope({
  body: z.object({
    doctorId: id,
    patientId: z.string().optional(),
    appointmentTypeId: id,
    slotStart: isoDateTime,
    idempotencyKey: z.string().optional(),
    patient: z.object({}).passthrough().default({}),
    notes: z.string().optional()
  })
});

export const confirmAppointmentSchema = envelope({ params: z.object({ id }) });

export const rescheduleAppointmentSchema = envelope({
  params: z.object({ id }),
  body: z.object({ newSlotStart: isoDateTime, reason: z.string().optional() })
});

export const cancelAppointmentSchema = envelope({
  params: z.object({ id }),
  body: z.object({ cancelledBy: z.enum(["patient", "clinic_staff", "system"]), reason: z.string().optional() })
});

export const appointmentIdSchema = envelope({ params: z.object({ id }) });

export const listAppointmentsSchema = envelope({
  params: z.object({ clinicId: id }),
  query: z.object({
    doctorId: z.string().optional(),
    date: z.string().optional(),
    status: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    patientId: z.string().optional(),
    after: z.string().optional(),
    limit: z.coerce.number().int().positive().max(100).optional()
  })
});

