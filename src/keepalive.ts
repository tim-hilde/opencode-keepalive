export type WakeLock = {
  release: () => void;
};

export type Schedule = (fn: () => void, ms: number) => () => void;

export type KeepaliveDeps = {
  acquire: () => WakeLock | null;
  graceMs: number;
  reattachWindowMs: number;
  schedule?: Schedule;
};

export type KeepaliveEvent = {
  type: string;
  data?: Record<string, unknown>;
};

export type Keepalive = {
  handleEvent: (event: KeepaliveEvent) => void;
  attach: () => () => void;
  isHolding: () => boolean;
  activeCount: () => number;
};

const SESSION_ENDED = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.deleted",
]);

const SHELL_ENDED = new Set(["shell.exited", "shell.deleted"]);

function field(record: unknown, key: string): unknown {
  if (typeof record !== "object" || record === null) return undefined;
  return (record as Record<string, unknown>)[key];
}

function stringField(record: unknown, key: string): string | undefined {
  const value = field(record, key);
  return typeof value === "string" ? value : undefined;
}

const scheduleUnref: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

export function createKeepalive(deps: KeepaliveDeps): Keepalive {
  const schedule = deps.schedule ?? scheduleUnref;
  const sessions = new Set<string>();
  // V2 ends a session's execution while its background shells keep running.
  const shells = new Set<string>();
  let lock: WakeLock | null = null;
  let cancelRelease: (() => void) | null = null;
  let attached = 0;
  let cancelOrphan: (() => void) | null = null;

  function activeCount(): number {
    return sessions.size + shells.size;
  }

  function release(): void {
    cancelRelease = null;
    lock?.release();
    lock = null;
  }

  function sync(): void {
    if (activeCount() > 0) {
      cancelRelease?.();
      cancelRelease = null;
      if (lock === null) lock = deps.acquire();
      return;
    }
    if (lock !== null && cancelRelease === null) {
      cancelRelease = schedule(release, deps.graceMs);
    }
  }

  // Without an attached registration no event stream is left, so running work
  // could never be seen to end and the lock would last until OpenCode exits.
  function orphan(): void {
    cancelOrphan = null;
    sessions.clear();
    shells.clear();
    sync();
  }

  // OpenCode may unload a registration before it sets up the next one in the
  // same module, so the state survives a re-attach within the window.
  function attach(): () => void {
    attached += 1;
    cancelOrphan?.();
    cancelOrphan = null;
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      attached -= 1;
      if (attached === 0) cancelOrphan = schedule(orphan, deps.reattachWindowMs);
    };
  }

  function handleEvent(event: KeepaliveEvent): void {
    const { type, data } = event;

    if (type === "session.execution.started" || SESSION_ENDED.has(type)) {
      const sessionID = stringField(data, "sessionID");
      if (sessionID === undefined) return;
      if (type === "session.execution.started") sessions.add(sessionID);
      else sessions.delete(sessionID);
      sync();
      return;
    }

    if (type === "shell.created") {
      const info = field(data, "info");
      const id = stringField(info, "id");
      const sessionID = stringField(field(info, "metadata"), "sessionID");
      if (id === undefined || sessionID === undefined) return;
      shells.add(id);
      sync();
      return;
    }

    if (SHELL_ENDED.has(type)) {
      const id = stringField(data, "id");
      if (id === undefined) return;
      shells.delete(id);
      sync();
    }
  }

  return {
    handleEvent,
    attach,
    isHolding: () => lock !== null,
    activeCount,
  };
}
