export type WakeLock = {
  release: () => void;
};

export type KeepaliveDeps = {
  acquire: () => WakeLock | null;
};

export type KeepaliveEvent = {
  type: string;
  properties?: Record<string, unknown>;
};

export type Keepalive = {
  handleEvent: (event: KeepaliveEvent) => void;
  isHolding: () => boolean;
  activeCount: () => number;
};

const ACTIVE_STATUS = new Set(["busy", "retry"]);

function readSessionID(properties: Record<string, unknown> | undefined): string | undefined {
  const value = properties?.["sessionID"];
  return typeof value === "string" ? value : undefined;
}

function readDeletedSessionID(properties: Record<string, unknown> | undefined): string | undefined {
  const info = properties?.["info"];
  if (typeof info !== "object" || info === null) return undefined;
  const id = (info as Record<string, unknown>)["id"];
  return typeof id === "string" ? id : undefined;
}

function readStatusType(properties: Record<string, unknown> | undefined): string | undefined {
  const status = properties?.["status"];
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
    const { type, properties } = event;

    if (type === "session.status") {
      const sessionID = readSessionID(properties);
      const statusType = readStatusType(properties);
      if (sessionID === undefined || statusType === undefined) return;
      if (ACTIVE_STATUS.has(statusType)) active.add(sessionID);
      else active.delete(sessionID);
      sync();
      return;
    }

    if (type === "session.deleted") {
      const sessionID = readDeletedSessionID(properties);
      if (sessionID === undefined) return;
      active.delete(sessionID);
      sync();
      return;
    }

    if (type === "session.error") {
      const sessionID = readSessionID(properties);
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
