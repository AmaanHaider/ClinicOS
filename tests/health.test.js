import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("health", () => {
  it("registers the health route", () => {
    const app = createApp();
    const hasHealthRoute = app._router.stack.some((layer) => {
      if (layer.route?.path === "/health" && layer.route?.methods?.get) return true;
      return layer.handle?.stack?.some((nested) => nested.route?.path === "/health" && nested.route?.methods?.get);
    });
    expect(hasHealthRoute).toBe(true);
  });
});
