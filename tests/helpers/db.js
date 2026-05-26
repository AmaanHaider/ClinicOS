import { connectDb, disconnectDb } from "../../src/config/db.js";

export async function setupTestDb() {
  await connectDb();
}

export async function teardownTestDb() {
  await disconnectDb();
}
