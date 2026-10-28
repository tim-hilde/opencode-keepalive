# opencode-keepalive

Keeps macOS awake while an OpenCode agent session is running.

## How it works

While any session execution is running (`session.execution.started` until
`succeeded`, `failed` or `interrupted`) or an agent's background shell is still
running, the plugin holds a `caffeinate -i -m -w <opencode pid>` process: the
system and disk are kept from idle-sleeping, while the display sleeps on its
normal schedule. Once nothing has been running for 30 minutes, the process is
killed and the assertion released; new activity within that window keeps the
existing process and restarts the countdown when it ends.

Background shells count because OpenCode ends the execution as soon as the
agent's turn ends, even while a shell it started (a long test run, say) keeps
going. A long-lived background process such as a dev server therefore keeps the
machine awake until it exits.

The `-w <pid>` flag makes `caffeinate` watch the OpenCode process, so the
assertion is released even if OpenCode is force-killed and no cleanup handler
gets to run.

OpenCode unloads the plugin after a plugin update or a configuration change.
The unloaded copy no longer receives events, so it cannot see the running work
end. When the next copy of the plugin starts, it adopts the sessions and shells
that the previous copy was tracking and takes its own wake lock. If OpenCode
does not register the unloaded copy again within 5 minutes, that copy forgets
its work and releases its wake lock after the normal 30-minute wait.

Events that arrive while no copy is subscribed are lost. If a session ends in
that short gap, the wake lock stays until OpenCode exits.

No cross-process coordination is needed: macOS power assertions from separate
processes stack, so several concurrent OpenCode instances each hold their own
and the machine stays awake until the last one finishes. That makes the lock
files and PID reference counting other implementations use unnecessary.

## Requirements

macOS. `caffeinate` ships with the OS. If it is unavailable, the plugin logs a
warning and does nothing.

## Install

Reference the repository in `~/.config/opencode/opencode.json`:

```json
{
  "plugins": [
    "opencode-keepalive@git+https://github.com/tim-hilde/opencode-keepalive.git#v0.1.1"
  ]
}
```

The npm package `opencode-keepalive` is a different plugin, so use the Git URL
and not the bare package name. To work on a local clone, reference its absolute
path instead.

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
holding `PreventUserIdleSystemSleep` and `PreventDiskIdle`. It disappears 30
minutes after the last session and agent shell have finished:

```bash
pgrep -fl "caffeinate -i -m -w"
```

## License

MIT
