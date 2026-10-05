export type WakeLock = {
  release: () => void;
};

export type KeepaliveDeps = {
  acquire: () => WakeLock | null;
};

export type KeepaliveEvent = {
  type: string;
  data?: Record<string, unknown>;
};

export type Keepalive = {
  handleEvent: (event: KeepaliveEvent) => void;
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

export function createKeepalive(deps: KeepaliveDeps): Keepalive {
  const sessions = new Set<string>();
  // V2 ends a session's execution while its background shells keep running.
  const shells = new Set<string>();
  let lock: WakeLock | null = null;

  function activeCount(): number {
    return sessions.size + shells.size;
  }

  function sync(): void {
    if (activeCount() > 0 && lock === null) {
      lock = deps.acquire();
      return;
    }
    if (activeCount() === 0 && lock !== null) {
      lock.release();
      lock = null;
    }
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
    isHolding: () => lock !== null,
    activeCount,
  };
}
