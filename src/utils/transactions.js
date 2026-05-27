/**
 * MongoDB transaction helper — withTransaction(fn) runs fn inside session.withTransaction.
 * Required for booking + event writes and waitlist accept.
 */
import mongoose from "mongoose";

export async function withTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

