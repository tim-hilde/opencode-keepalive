import { Plugin } from "@opencode/plugin";
import { createCaffeinateAcquirer, type Logger } from "./caffeinate.ts";
import { createKeepalive, type KeepaliveEvent } from "./keepalive.ts";

let log: Logger = () => {};

// Module scope: if OpenCode registers this plugin more than once, all
// registrations share one state machine and one caffeinate process.
const keepalive = createKeepalive({
  acquire: createCaffeinateAcquirer((level, message) => {
    log(level, message);
  }),
});

export default Plugin.define({
  id: "opencode-keepalive",
  setup(ctx) {
    log = (level, message) => {
      if (level === "warn") console.warn(`[opencode-keepalive] ${message}`);
      else console.debug(`[opencode-keepalive] ${message}`);
    };

    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        keepalive.handleEvent(event as unknown as KeepaliveEvent);
      }
    })();

    return () => {
      controller.abort();
    };
  },
});
