import { z } from "zod";
import { dateOnly, envelope, id, windowSchema } from "./common.js";

const weeklyTemplate = z.object({
  MON: z.array(windowSchema).default([]),
  TUE: z.array(windowSchema).default([]),
  WED: z.array(windowSchema).default([]),
  THU: z.array(windowSchema).default([]),
  FRI: z.array(windowSchema).default([]),
  SAT: z.array(windowSchema).default([]),
  SUN: z.array(windowSchema).default([])
}).strict();

export const putAvailabilitySchema = envelope({
  params: z.object({ id }),
  body: z.object({ weeklyTemplate })
});

export const exceptionSchema = envelope({
  params: z.object({ id }),
  body: z.discriminatedUnion("type", [
    z.object({ date: dateOnly, type: z.literal("block"), reason: z.string().optional() }),
    z.object({ date: dateOnly, type: z.literal("override"), windows: z.array(windowSchema).min(1), reason: z.string().optional() }),
    z.object({ date: dateOnly, type: z.literal("additional"), windows: z.array(windowSchema).min(1), reason: z.string().optional() })
  ])
});

export const deleteExceptionSchema = envelope({
  params: z.object({ id, date: dateOnly })
});

export const validateAvailabilitySchema = envelope({
  params: z.object({ id }),
  body: z.object({
    proposedTemplate: weeklyTemplate,
    dateRange: z.object({ from: dateOnly, to: dateOnly })
  })
});

