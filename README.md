# opencode-keepalive

Keeps macOS awake while an OpenCode agent session is running.

## How it works

While any session reports `busy` or `retry`, the plugin holds a
`caffeinate -i -m -w <opencode pid>` process: the system and disk are kept from
idle-sleeping, while the display sleeps on its normal schedule. Once every
session is idle again, the process is killed and the assertion released.

The `-w <pid>` flag makes `caffeinate` watch the OpenCode process, so the
assertion is released even if OpenCode is force-killed and no cleanup handler
gets to run.

No cross-process coordination is needed: macOS power assertions from separate
processes stack, so several concurrent OpenCode instances each hold their own
and the machine stays awake until the last one finishes. That makes the lock
files and PID reference counting other implementations use unnecessary.

## Requirements

macOS. `caffeinate` ships with the OS. If it is unavailable, the plugin logs a
warning and does nothing.

## Install

Clone the repo, then reference the directory in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["/absolute/path/to/opencode-keepalive"]
}
```

No build step — OpenCode loads the TypeScript source directly.

## Development

```bash
bun install
bun test
bun run typecheck
```

`src/keepalive.ts` holds the state machine and is tested without touching real
processes. `src/caffeinate.ts` owns the spawn and has one integration test that
asserts against real `pmset` output.

## Verifying

With an agent running, `pmset -g assertions` should list a `caffeinate` process
holding `PreventUserIdleSystemSleep` and `PreventDiskIdle`. It disappears once
all sessions are idle:

```bash
pgrep -fl "caffeinate -i -m -w"
```

## License

MIT
