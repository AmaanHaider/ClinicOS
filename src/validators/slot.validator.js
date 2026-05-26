import { z } from "zod";
import { dateOnly, envelope, id } from "./common.js";

export const slotQuerySchema = envelope({
  query: z.object({
    doctorId: id,
    clinicId: id,
    appointmentType: id,
    from: dateOnly,
    to: dateOnly
  })
});

