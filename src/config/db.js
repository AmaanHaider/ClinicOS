import mongoose from "mongoose";
import { env } from "./env.js";

export async function connectDb(uri = env.MONGODB_URI) {
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri, { maxPoolSize: 50, serverSelectionTimeoutMS: 5000 });
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

