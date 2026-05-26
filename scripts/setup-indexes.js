import { connectDb, disconnectDb } from "../src/config/db.js";
import * as models from "../src/models/index.js";

await connectDb();
for (const model of Object.values(models)) {
  if (model?.syncIndexes) {
    await model.syncIndexes();
    console.log(`synced indexes: ${model.modelName}`);
  }
}
await disconnectDb();

