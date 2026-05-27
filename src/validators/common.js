import { z } from "zod";

export const id = z.string().min(1);
export const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const isoDateTime = z.string().datetime({ offset: true });
export const time = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/);
export const windowSchema = z.object({ start: time, end: time });

export function envelope({ body = z.any(), query = z.any(), params = z.any() }) {
  return z.object({ body, query, params });
}

