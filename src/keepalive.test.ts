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

function status(sessionID: string, type: "busy" | "idle" | "retry") {
  return { type: "session.status", properties: { sessionID, status: { type } } };
}

describe("createKeepalive", () => {
  test("acquires a wake lock when a session becomes busy", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(status("s1", "busy"));
    expect(h.counts().acquire).toBe(1);
    expect(h.keepalive.isHolding()).toBe(true);
  });

  test("does not acquire twice for a second busy session", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(status("s1", "busy"));
    h.keepalive.handleEvent(status("s2", "busy"));
    expect(h.counts().acquire).toBe(1);
    expect(h.keepalive.activeCount()).toBe(2);
  });

  test("does not acquire twice for repeated busy of the same session", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(status("s1", "busy"));
    h.keepalive.handleEvent(status("s1", "busy"));
    expect(h.counts().acquire).toBe(1);
    expect(h.keepalive.activeCount()).toBe(1);
  });

  test("holds the lock while one of two sessions goes idle", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(status("s1", "busy"));
    h.keepalive.handleEvent(status("s2", "busy"));
    h.keepalive.handleEvent(status("s1", "idle"));
    expect(h.counts().release).toBe(0);
    expect(h.keepalive.isHolding()).toBe(true);
  });

  test("releases the lock when the last session goes idle", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(status("s1", "busy"));
    h.keepalive.handleEvent(status("s1", "idle"));
    expect(h.counts().release).toBe(1);
    expect(h.keepalive.isHolding()).toBe(false);
  });

  test("treats retry as active", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(status("s1", "retry"));
    expect(h.keepalive.isHolding()).toBe(true);
  });

  test("releases on session.deleted", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(status("s1", "busy"));
    h.keepalive.handleEvent({ type: "session.deleted", properties: { info: { id: "s1" } } });
    expect(h.keepalive.isHolding()).toBe(false);
  });

  test("releases on session.error", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(status("s1", "busy"));
    h.keepalive.handleEvent({ type: "session.error", properties: { sessionID: "s1" } });
    expect(h.keepalive.isHolding()).toBe(false);
  });

  test("ignores session.error without a sessionID", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(status("s1", "busy"));
    h.keepalive.handleEvent({ type: "session.error", properties: {} });
    expect(h.keepalive.isHolding()).toBe(true);
  });

  test("idle for an unknown session is a no-op", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(status("ghost", "idle"));
    expect(h.counts().acquire).toBe(0);
    expect(h.counts().release).toBe(0);
  });

  test("ignores unrelated events", () => {
    const h = makeHarness();
    h.keepalive.handleEvent({ type: "file.edited", properties: { file: "a.ts" } });
    expect(h.counts().acquire).toBe(0);
  });

  test("re-acquires after a full release cycle", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(status("s1", "busy"));
    h.keepalive.handleEvent(status("s1", "idle"));
    h.keepalive.handleEvent(status("s1", "busy"));
    expect(h.counts().acquire).toBe(2);
    expect(h.counts().release).toBe(1);
  });

  test("stays released when acquire fails", () => {
    const keepalive = createKeepalive({ acquire: () => null });
    keepalive.handleEvent(status("s1", "busy"));
    expect(keepalive.isHolding()).toBe(false);
    keepalive.handleEvent(status("s1", "idle"));
    expect(keepalive.isHolding()).toBe(false);
  });
});
