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

const ACTIVE_STATUS = new Set(["busy", "retry"]);

function readSessionID(data: Record<string, unknown> | undefined): string | undefined {
  const value = data?.["sessionID"];
  return typeof value === "string" ? value : undefined;
}

function readStatusType(data: Record<string, unknown> | undefined): string | undefined {
  const status = data?.["status"];
  if (typeof status !== "object" || status === null) return undefined;
  const type = (status as Record<string, unknown>)["type"];
  return typeof type === "string" ? type : undefined;
}

export function createKeepalive(deps: KeepaliveDeps): Keepalive {
  const active = new Set<string>();
  let lock: WakeLock | null = null;

  function sync(): void {
    if (active.size > 0 && lock === null) {
      lock = deps.acquire();
      return;
    }
    if (active.size === 0 && lock !== null) {
      lock.release();
      lock = null;
    }
  }

  function handleEvent(event: KeepaliveEvent): void {
    const { type, data } = event;

    if (type === "session.status") {
      const sessionID = readSessionID(data);
      const statusType = readStatusType(data);
      if (sessionID === undefined || statusType === undefined) return;
      if (ACTIVE_STATUS.has(statusType)) active.add(sessionID);
      else active.delete(sessionID);
      sync();
      return;
    }

    if (type === "session.deleted") {
      const sessionID = readSessionID(data);
      if (sessionID === undefined) return;
      active.delete(sessionID);
      sync();
    }
  }

  return {
    handleEvent,
    isHolding: () => lock !== null,
    activeCount: () => active.size,
  };
}
