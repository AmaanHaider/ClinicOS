import cors from "cors";
import express from "express";
import helmet from "helmet";
import { errorHandler, notFound } from "./middleware/error.js";
import { routes } from "./routes/index.js";

export function createApp() {
  const app = express();
  app.use(helmet());
  app.use(cors());
  app.use(express.json());
  app.use(routes);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

