import { describe, expect, test } from "bun:test";
import { createKeepalive, type KeepaliveRegistry, type KeepaliveSnapshot } from "./keepalive.ts";

const GRACE = 1000;
const REATTACH_WINDOW = 100;

function makeHarness(options: { acquireFails?: boolean; registry?: KeepaliveRegistry } = {}) {
  let acquireCount = 0;
  let releaseCount = 0;
  let now = 0;
  let timers: { due: number; fn: () => void; cancelled: boolean }[] = [];
  const keepalive = createKeepalive({
    acquire: () => {
      acquireCount += 1;
      if (options.acquireFails) return null;
      return {
        release: () => {
          releaseCount += 1;
        },
      };
    },
    graceMs: GRACE,
    reattachWindowMs: REATTACH_WINDOW,
    registry: options.registry,
    schedule: (fn, ms) => {
      const timer = { due: now + ms, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  return {
    keepalive,
    counts: () => ({ acquire: acquireCount, release: releaseCount }),
    advance: (ms: number) => {
      now += ms;
      const due = timers.filter((timer) => timer.due <= now);
      timers = timers.filter((timer) => timer.due > now);
      for (const timer of due) if (!timer.cancelled) timer.fn();
    },
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
    h.advance(GRACE);
    expect(h.counts().release).toBe(0);
    expect(h.keepalive.isHolding()).toBe(true);
  });

  for (const outcome of ["succeeded", "failed", "interrupted"] as const) {
    test(`releases the lock a grace period after the last execution ${outcome}`, () => {
      const h = makeHarness();
      h.keepalive.handleEvent(started("s1"));
      h.keepalive.handleEvent(ended("s1", outcome));
      h.advance(GRACE);
      expect(h.counts().release).toBe(1);
      expect(h.keepalive.isHolding()).toBe(false);
    });
  }

  test("keeps holding until the grace period has fully elapsed", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(started("s1"));
    h.keepalive.handleEvent(ended("s1"));
    h.advance(GRACE - 1);
    expect(h.counts().release).toBe(0);
    expect(h.keepalive.isHolding()).toBe(true);
  });

  test("activity during the grace period keeps the existing lock", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(started("s1"));
    h.keepalive.handleEvent(ended("s1"));
    h.advance(GRACE / 2);
    h.keepalive.handleEvent(started("s2"));
    h.advance(GRACE);
    expect(h.counts().acquire).toBe(1);
    expect(h.counts().release).toBe(0);
    expect(h.keepalive.isHolding()).toBe(true);
  });

  test("the grace period restarts when resumed activity ends", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(started("s1"));
    h.keepalive.handleEvent(ended("s1"));
    h.advance(GRACE / 2);
    h.keepalive.handleEvent(started("s1"));
    h.keepalive.handleEvent(ended("s1"));
    h.advance(GRACE - 1);
    expect(h.counts().release).toBe(0);
    h.advance(1);
    expect(h.counts().release).toBe(1);
  });

  test("releases a grace period after session.deleted", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(started("s1"));
    h.keepalive.handleEvent({ type: "session.deleted", data: { sessionID: "s1" } });
    h.advance(GRACE);
    expect(h.keepalive.isHolding()).toBe(false);
  });

  test("an execution end for an unknown session is a no-op", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(ended("ghost"));
    h.advance(GRACE);
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
    h.advance(GRACE);
    h.keepalive.handleEvent(started("s1"));
    expect(h.counts().acquire).toBe(2);
    expect(h.counts().release).toBe(1);
  });

  test("stays released when acquire fails", () => {
    const h = makeHarness({ acquireFails: true });
    h.keepalive.handleEvent(started("s1"));
    expect(h.keepalive.isHolding()).toBe(false);
    h.keepalive.handleEvent(ended("s1"));
    h.advance(GRACE);
    expect(h.keepalive.isHolding()).toBe(false);
    expect(h.counts().release).toBe(0);
  });

  test("keeps holding while an agent shell outlives the execution", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(started("s1"));
    h.keepalive.handleEvent(shellCreated("sh_1"));
    h.keepalive.handleEvent(ended("s1"));
    h.advance(GRACE);
    expect(h.counts().release).toBe(0);
    expect(h.keepalive.isHolding()).toBe(true);
  });

  test("releases a grace period after the last agent shell exits", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(started("s1"));
    h.keepalive.handleEvent(shellCreated("sh_1"));
    h.keepalive.handleEvent(ended("s1"));
    h.keepalive.handleEvent(shellExited("sh_1"));
    h.advance(GRACE - 1);
    expect(h.keepalive.isHolding()).toBe(true);
    h.advance(1);
    expect(h.counts().release).toBe(1);
    expect(h.keepalive.isHolding()).toBe(false);
  });

  test("releases a grace period after shell.deleted", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(shellCreated("sh_1"));
    h.keepalive.handleEvent({ type: "shell.deleted", data: { id: "sh_1" } });
    h.advance(GRACE);
    expect(h.keepalive.isHolding()).toBe(false);
  });

  test("ignores shells that do not belong to a session", () => {
    const h = makeHarness();
    h.keepalive.handleEvent(shellCreated("sh_1", {}));
    expect(h.counts().acquire).toBe(0);
  });
});

describe("attach", () => {
  test("releases a grace period after the last registration detaches mid-session", () => {
    const h = makeHarness();
    const detach = h.keepalive.attach();
    h.keepalive.handleEvent(started("s1"));
    detach();
    h.advance(REATTACH_WINDOW);
    h.advance(GRACE - 1);
    expect(h.keepalive.isHolding()).toBe(true);
    h.advance(1);
    expect(h.counts().release).toBe(1);
    expect(h.keepalive.isHolding()).toBe(false);
  });

  test("keeps tracking when a registration re-attaches within the window", () => {
    const h = makeHarness();
    const detach = h.keepalive.attach();
    h.keepalive.handleEvent(started("s1"));
    detach();
    h.advance(REATTACH_WINDOW - 1);
    h.keepalive.attach();
    h.advance(REATTACH_WINDOW + GRACE);
    expect(h.counts().release).toBe(0);
    expect(h.keepalive.activeCount()).toBe(1);
    h.keepalive.handleEvent(ended("s1"));
    h.advance(GRACE);
    expect(h.counts().release).toBe(1);
  });

  test("keeps the lock while another registration is still attached", () => {
    const h = makeHarness();
    const detachFirst = h.keepalive.attach();
    h.keepalive.attach();
    h.keepalive.handleEvent(started("s1"));
    detachFirst();
    h.advance(REATTACH_WINDOW + GRACE);
    expect(h.counts().release).toBe(0);
    expect(h.keepalive.isHolding()).toBe(true);
  });

  test("detaching the same registration twice counts once", () => {
    const h = makeHarness();
    const detachFirst = h.keepalive.attach();
    h.keepalive.attach();
    h.keepalive.handleEvent(started("s1"));
    detachFirst();
    detachFirst();
    h.advance(REATTACH_WINDOW + GRACE);
    expect(h.keepalive.isHolding()).toBe(true);
  });

  test("forgets work that was running when the last registration detached", () => {
    const h = makeHarness();
    const detach = h.keepalive.attach();
    h.keepalive.handleEvent(started("s1"));
    h.keepalive.handleEvent(shellCreated("sh_1"));
    detach();
    h.advance(REATTACH_WINDOW);
    h.advance(GRACE);
    h.keepalive.attach();
    expect(h.keepalive.activeCount()).toBe(0);
    expect(h.keepalive.isHolding()).toBe(false);
  });

  test("reuses the held lock when work starts during the grace period after forgetting", () => {
    const h = makeHarness();
    const detach = h.keepalive.attach();
    h.keepalive.handleEvent(started("s1"));
    detach();
    h.advance(REATTACH_WINDOW);
    h.keepalive.attach();
    h.keepalive.handleEvent(started("s2"));
    h.advance(GRACE);
    expect(h.counts().acquire).toBe(1);
    expect(h.counts().release).toBe(0);
  });
});

describe("takeover", () => {
  test("a new copy adopts the work a previous copy was tracking", () => {
    const registry: KeepaliveRegistry = {};
    const previous = makeHarness({ registry });
    const detachPrevious = previous.keepalive.attach();
    previous.keepalive.handleEvent(started("s1"));
    previous.keepalive.handleEvent(shellCreated("sh_1"));
    detachPrevious();
    const next = makeHarness({ registry });
    next.keepalive.attach();
    expect(next.keepalive.activeCount()).toBe(2);
    expect(next.keepalive.isHolding()).toBe(true);
  });

  test("adopted work ends through the new copy's events", () => {
    const registry: KeepaliveRegistry = {};
    const previous = makeHarness({ registry });
    previous.keepalive.attach();
    previous.keepalive.handleEvent(started("s1"));
    const next = makeHarness({ registry });
    next.keepalive.attach();
    next.keepalive.handleEvent(ended("s1"));
    next.advance(GRACE);
    expect(next.counts().release).toBe(1);
    expect(next.keepalive.isHolding()).toBe(false);
  });

  test("adopts the work as it stood when the previous copy closed", () => {
    const registry: KeepaliveRegistry = {};
    const previous = makeHarness({ registry });
    const detachPrevious = previous.keepalive.attach();
    previous.keepalive.handleEvent(started("s1"));
    const next = makeHarness({ registry });
    previous.keepalive.handleEvent(started("s2"));
    detachPrevious();
    next.keepalive.attach();
    expect(next.keepalive.activeCount()).toBe(2);
  });

  test("each new copy adopts from the most recent one", () => {
    const registry: KeepaliveRegistry = {};
    const first = makeHarness({ registry });
    const detachFirst = first.keepalive.attach();
    first.keepalive.handleEvent(started("s1"));
    detachFirst();
    const second = makeHarness({ registry });
    const detachSecond = second.keepalive.attach();
    second.keepalive.handleEvent(started("s2"));
    detachSecond();
    const third = makeHarness({ registry });
    third.keepalive.attach();
    expect(third.keepalive.activeCount()).toBe(2);
  });

  test("a copy that was attached before keeps its own state on re-attach", () => {
    const registry: KeepaliveRegistry = {};
    const y = makeHarness({ registry });
    const detachY = y.keepalive.attach();
    const x = makeHarness({ registry });
    const detachX = x.keepalive.attach();
    x.keepalive.handleEvent(started("s1"));
    y.keepalive.handleEvent(started("s1"));
    detachX();
    y.keepalive.handleEvent(ended("s1"));
    detachY();
    y.keepalive.attach();
    expect(y.keepalive.activeCount()).toBe(0);
  });

  test("starts empty when the previous copy's snapshot throws", () => {
    const registry: KeepaliveRegistry = {
      latest: {
        snapshot: () => {
          throw new Error("incompatible");
        },
      },
    };
    const next = makeHarness({ registry });
    expect(() => next.keepalive.attach()).not.toThrow();
    expect(next.keepalive.activeCount()).toBe(0);
  });

  test("adopts only string ids from a malformed snapshot", () => {
    const malformed = { sessions: ["s1", 42], shells: "sh_1" } as unknown as KeepaliveSnapshot;
    const registry: KeepaliveRegistry = { latest: { snapshot: () => malformed } };
    const next = makeHarness({ registry });
    next.keepalive.attach();
    expect(next.keepalive.activeCount()).toBe(1);
  });

  test("adopts nothing from a previous copy that already forgot its work", () => {
    const registry: KeepaliveRegistry = {};
    const previous = makeHarness({ registry });
    const detachPrevious = previous.keepalive.attach();
    previous.keepalive.handleEvent(started("s1"));
    detachPrevious();
    previous.advance(REATTACH_WINDOW);
    const next = makeHarness({ registry });
    next.keepalive.attach();
    expect(next.keepalive.activeCount()).toBe(0);
    expect(next.counts().acquire).toBe(0);
  });
});
