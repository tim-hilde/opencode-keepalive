import { describe, expect, test } from "bun:test";

describe("plugin module", () => {
  test("default-exports a V2 plugin definition with id and setup", async () => {
    const mod = await import("./index.ts");
    const plugin = mod.default as { id?: string; setup?: unknown };
    expect(plugin.id).toBe("opencode-keepalive");
    expect(typeof plugin.setup).toBe("function");
  });
});
