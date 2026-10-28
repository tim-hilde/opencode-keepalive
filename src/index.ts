import { Plugin } from "@opencode/plugin";
import { createCaffeinateAcquirer, type Logger } from "./caffeinate.ts";
import { createKeepalive, type KeepaliveEvent, type KeepaliveRegistry } from "./keepalive.ts";

let log: Logger = () => {};

const globals = globalThis as unknown as Record<symbol, KeepaliveRegistry | undefined>;
const registryKey = Symbol.for("opencode-keepalive.registry");
const registry = (globals[registryKey] ??= {});

// Module scope: if OpenCode registers this plugin more than once, all
// registrations share one state machine and one caffeinate process.
const keepalive = createKeepalive({
  acquire: createCaffeinateAcquirer((level, message) => {
    log(level, message);
  }),
  graceMs: 30 * 60 * 1000,
  reattachWindowMs: 5 * 60 * 1000,
  registry,
});

export default Plugin.define({
  id: "opencode-keepalive",
  setup(ctx) {
    log = (level, message) => {
      if (level === "warn") console.warn(`[opencode-keepalive] ${message}`);
      else console.debug(`[opencode-keepalive] ${message}`);
    };

    const detach = keepalive.attach();
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          keepalive.handleEvent(event as unknown as KeepaliveEvent);
        }
      } catch (error) {
        if (!controller.signal.aborted) log("warn", `event stream failed: ${String(error)}`);
      } finally {
        detach();
      }
    })();

    return () => {
      controller.abort();
      detach();
    };
  },
});
