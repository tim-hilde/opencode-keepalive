import { execFileSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { createCaffeinateAcquirer } from "./caffeinate.ts";
import { createKeepalive } from "./keepalive.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function runningCaffeinatePids(): string[] {
  try {
    return execFileSync("pgrep", ["-f", "caffeinate -i -m -w"], { encoding: "utf-8" })
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function assertionHeld(): boolean {
  const output = execFileSync("pmset", ["-g", "assertions"], { encoding: "utf-8" });
  return output
    .split("\n")
    .some((line) => line.includes("caffeinate") && line.includes("PreventUserIdleSystemSleep"));
}

describe("caffeinate integration", () => {
  test("holds a real power assertion while a session is running", async () => {
    const before = runningCaffeinatePids();
    const keepalive = createKeepalive({ acquire: createCaffeinateAcquirer(() => {}) });

    keepalive.handleEvent({ type: "session.execution.started", data: { sessionID: "s1" } });
    await sleep(700);

    expect(keepalive.isHolding()).toBe(true);
    expect(runningCaffeinatePids().length).toBe(before.length + 1);
    expect(assertionHeld()).toBe(true);

    keepalive.handleEvent({ type: "session.execution.succeeded", data: { sessionID: "s1" } });
    await sleep(700);

    expect(keepalive.isHolding()).toBe(false);
    expect(runningCaffeinatePids().length).toBe(before.length);
  });
});
