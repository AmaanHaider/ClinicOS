import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  MONGODB_URI: z.string().default("mongodb://localhost:27017/clinic_scheduling?replicaSet=rs0"),
  JWT_SECRET: z.string().default("dev-secret"),
  JWT_EXPIRES_IN: z.string().default("7d"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  MAX_SLOT_QUERY_DAYS: z.coerce.number().default(30),
  PENDING_HOLD_MINUTES: z.coerce.number().default(5),
  WAITLIST_OFFER_MINUTES: z.coerce.number().default(15)
});

export const env = schema.parse(process.env);

