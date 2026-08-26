import { spawn } from "node:child_process";
import type { WakeLock } from "./keepalive.ts";

export type Logger = (level: "debug" | "warn", message: string) => void;

/**
 * `-w <pid>` makes caffeinate watch the OpenCode process and drop the
 * assertion on its own if OpenCode dies without releasing it.
 */
export function createCaffeinateAcquirer(log: Logger, watchPid: number = process.pid) {
  return function acquire(): WakeLock | null {
    try {
      const child = spawn("caffeinate", ["-i", "-m", "-w", String(watchPid)], {
        stdio: "ignore",
      });
      child.unref();
      child.on("error", (error) => {
        log("warn", `caffeinate failed to start: ${String(error)}`);
      });
      log("debug", `caffeinate acquired (pid ${String(child.pid)})`);
      return {
        release: () => {
          child.kill();
          log("debug", "caffeinate released");
        },
      };
    } catch (error) {
      log("warn", `caffeinate spawn threw: ${String(error)}`);
      return null;
    }
  };
}
