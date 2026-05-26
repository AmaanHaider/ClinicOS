import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import swaggerUi from "swagger-ui-express";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const specPath = join(__dirname, "../../openapi/openapi.yaml");

let cachedSpec;

function loadSpec() {
  if (!cachedSpec) {
    cachedSpec = parseYaml(readFileSync(specPath, "utf8"));
  }
  return cachedSpec;
}

export function mountSwagger(app) {
  const spec = loadSpec();
  app.get("/api-docs/openapi.json", (_req, res) => res.json(spec));
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(spec, {
    customSiteTitle: "ClinicOS API",
    swaggerOptions: { persistAuthorization: true }
  }));
}
