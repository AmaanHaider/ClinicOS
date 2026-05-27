/** Zod schemas for POST /waitlist and waitlist accept/remove by id. */
import { z } from "zod";
import { dateOnly, envelope, id } from "./common.js";

export const joinWaitlistSchema = envelope({
  body: z.object({
    doctorId: id,
    targetDate: dateOnly,
    appointmentTypeId: id,
    patientId: z.string().optional(),
    patient: z.object({}).passthrough().default({}),
    urgencyFlag: z.boolean().default(false)
  })
});

export const waitlistIdSchema = envelope({ params: z.object({ id }) });

