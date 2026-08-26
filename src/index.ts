import type { Plugin, PluginInput } from "@opencode-ai/plugin";
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

export const OpencodeKeepalive: Plugin = async (input: PluginInput) => {
  log = (level, message) => {
    void input.client.app.log({
      body: { service: "opencode-keepalive", level, message },
    });
  };

  return {
    event: async ({ event }) => {
      keepalive.handleEvent(event as unknown as KeepaliveEvent);
    },
  };
};

export default OpencodeKeepalive;
