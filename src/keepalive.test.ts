import { describe, expect, test } from "bun:test";
import { createKeepalive } from "./keepalive.ts";

function makeHarness() {
  let acquireCount = 0;
  let releaseCount = 0;
  const keepalive = createKeepalive({
    acquire: () => {
      acquireCount += 1;
      return {
        release: () => {
          releaseCount += 1;
        },
      };
    },
  });
  return {
    keepalive,
    counts: () => ({ acquire: acquireCount, release: releaseCount }),
  };
}

function started(sessionID: string) {
  return { type: "session.execution.started", data: { sessionID } };
}

function ended(sessionID: string, outcome: "succeeded" | "failed" | "interrupted" = "succeeded") {
  return { type: `session.execution.${outcome}`, data: { sessionID } };
}

function shellCreated(id: string, metadata: Record<string, unknown> = { sessionID: "s1" }) {
  return { type: "shell.created", data: { info: { id, status: "running", metadata } } };
}

function shellExited(id: string) {
  return { type: "shell.exited", data: { id, status: "exited" } };
}

describe("createKeepalive", () => {
  test("acquires a wake lock when a session execution starts", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(started("s1"));
    expect(h.counts().acquire).toBe(1);
    expect(h.keepalive.isHolding()).toBe(true);
  });

  test("does not acquire twice for a second running session", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(started("s1"));
    h.keepalive.handleEvent(started("s2"));
    expect(h.counts().acquire).toBe(1);
    expect(h.keepalive.activeCount()).toBe(2);
  });

  test("does not acquire twice for repeated starts of the same session", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(started("s1"));
    h.keepalive.handleEvent(started("s1"));
    expect(h.counts().acquire).toBe(1);
    expect(h.keepalive.activeCount()).toBe(1);
  });

  test("holds the lock while one of two sessions finishes", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(started("s1"));
    h.keepalive.handleEvent(started("s2"));
    h.keepalive.handleEvent(ended("s1"));
    expect(h.counts().release).toBe(0);
    expect(h.keepalive.isHolding()).toBe(true);
  });

  for (const outcome of ["succeeded", "failed", "interrupted"] as const) {
    test(`releases the lock when the last execution ${outcome}`, () => {
      const h = makeHarness();
      h.keepalive.handleEvent(started("s1"));
      h.keepalive.handleEvent(ended("s1", outcome));
      expect(h.counts().release).toBe(1);
      expect(h.keepalive.isHolding()).toBe(false);
    });
  }

  test("releases on session.deleted", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(started("s1"));
    h.keepalive.handleEvent({ type: "session.deleted", data: { sessionID: "s1" } });
    expect(h.keepalive.isHolding()).toBe(false);
  });

  test("an execution end for an unknown session is a no-op", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(ended("ghost"));
    expect(h.counts().acquire).toBe(0);
    expect(h.counts().release).toBe(0);
  });

  test("ignores unrelated events", () => {
    const h = makeHarness();
    h.keepalive.handleEvent({ type: "file.edited", data: { file: "a.ts" } });
    expect(h.counts().acquire).toBe(0);
  });

  test("re-acquires after a full release cycle", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(started("s1"));
    h.keepalive.handleEvent(ended("s1"));
    h.keepalive.handleEvent(started("s1"));
    expect(h.counts().acquire).toBe(2);
    expect(h.counts().release).toBe(1);
  });

  test("stays released when acquire fails", () => {
    const keepalive = createKeepalive({ acquire: () => null });
    keepalive.handleEvent(started("s1"));
    expect(keepalive.isHolding()).toBe(false);
    keepalive.handleEvent(ended("s1"));
    expect(keepalive.isHolding()).toBe(false);
  });

  test("keeps holding while an agent shell outlives the execution", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(started("s1"));
    h.keepalive.handleEvent(shellCreated("sh_1"));
    h.keepalive.handleEvent(ended("s1"));
    expect(h.counts().release).toBe(0);
    expect(h.keepalive.isHolding()).toBe(true);
  });

  test("releases once the last agent shell exits", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(started("s1"));
    h.keepalive.handleEvent(shellCreated("sh_1"));
    h.keepalive.handleEvent(ended("s1"));
    h.keepalive.handleEvent(shellExited("sh_1"));
    expect(h.counts().release).toBe(1);
    expect(h.keepalive.isHolding()).toBe(false);
  });

  test("releases on shell.deleted", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(shellCreated("sh_1"));
    h.keepalive.handleEvent({ type: "shell.deleted", data: { id: "sh_1" } });
    expect(h.keepalive.isHolding()).toBe(false);
  });

  test("ignores shells that do not belong to a session", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(shellCreated("sh_1", {}));
    expect(h.counts().acquire).toBe(0);
  });
});
