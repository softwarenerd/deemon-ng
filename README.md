# deemon-ng

Run a long-lived process in the background and attach to it, without ever losing the reason it
failed.

A rewrite of [deemon](https://github.com/joaomoreno/deemon) with the same command line, the
same output phrases, and none of the failure modes that make a broken build script look like a
broken daemon.

```
$ deemon npm run watch-client
[deemon] Spawned build daemon. Press Ctrl-C to detach, Ctrl-D to kill.
Starting compilation...
Finished compilation with 0 errors
```

## The problem it exists to solve

With deemon, a build script that fails during startup reports this instead:

```
Error: connect ENOENT /var/folders/b6/ffs4q0.../T/daemon-8f5b19370d159ed421f1c3f4e073232b.sock
    at PipeConnectWrap.afterConnect [as oncomplete] (node:net:1705:16) {
  errno: -2,
  code: 'ENOENT',
  syscall: 'connect',
  ...
}
```

The message is not about the socket. It means *the command you asked to run died, and the
daemon threw away its error message before you could read it.* Here is the sequence, with
measured timings from a Positron checkout:

| Time | What happens |
|---|---|
| 0 ms | The client connects, gets ENOENT (no daemon yet), spawns one with `stdio: 'ignore'` |
| 36 ms | The daemon binds the socket and spawns your command |
| 154 ms | **Your command fails.** The daemon calls `server.close()`, and Node unlinks the socket file |
| 200 ms | The client wakes from a hardcoded sleep, makes its single connection attempt, gets ENOENT |

The client then prints the raw `Error` object, because that second connection attempt sits
outside deemon's `try`/`catch`. Nothing anywhere records what your command actually said.

This is why the symptom shows up most on a fresh clone: that is when build scripts genuinely
fail for want of a prerequisite. It also explains why only *some* watchers are affected, and
why retrying sometimes appears to fix it.

## What is different

Every one of these is covered by a test in [`test/regressions.test.js`](test/regressions.test.js).

**A command that fails is reported as a command that failed.** The daemon persists its child's
exit code, timing and output to disk the instant the child dies, then keeps serving for a
linger window instead of closing the server. A client mid-handshake gets the real exit code; a
client that arrives an hour later still gets an explanation.

```
$ deemon npm run watch-copilot
[deemon] Spawned build daemon. Press Ctrl-C to detach, Ctrl-D to kill.
npm error Missing script: "watch"
[deemon] `npm run watch-copilot` exited with code 1 after 112ms.
[deemon] Build daemon exited with code 1.
$ echo $?
1
```

**"No daemon running" is no longer a dead end.**

```
$ deemon --attach npm run watch-copilot
[deemon] No daemon running.
[deemon] Last run: `npm run watch-copilot` exited with code 1 after 112ms.
[deemon] Stopped at 7/31/2026, 12:42:58 PM.
[deemon] Last output:
[deemon]   | npm error Missing script: "watch"
[deemon] Full log: ~/.local/state/deemon-ng/ab5bc075....log
```

**No fixed sleep, and no single connection attempt.** The client polls until the daemon is
listening, bounded by `--timeout`, while watching the daemon process. If the daemon dies during
bootstrap, that is reported immediately, with the daemon's own output, because its stdio goes
to a log file rather than to `/dev/null`.

**A raw `Error` object can never reach the terminal.** Every failure path, including
`uncaughtException` and `unhandledRejection`, funnels through one reporter that prints a
sentence a person can act on.

**Output and exit status travel separately.** deemon sent the child's exit code as the final
byte of the output stream, so its client withheld the last byte of every chunk and guessed,
on a 100 ms timer, when to flush it; on close it read that held byte as the process exit code.
Attempts to make this actually lose data did not succeed, so treat it as fragile by
construction rather than as a demonstrated bug: `client.end(exitByte)` is followed immediately
by `client.destroy()`, which can drop the final write, and a one-byte final chunk is held with
no flush timer at all. deemon-ng frames every message explicitly, so output and exit status
cannot be mistaken for one another regardless of chunk boundaries.

**`--detach` tells you the truth.** It waits for the daemon to be *listening*, not merely
spawned, then waits `--settle` (750 ms by default) and confirms the command is still alive. A
script that starts five watchers now reports which ones actually came up.

**`--kill` confirms, and takes the whole tree.** It waits for the daemon to acknowledge instead
of firing and forgetting, and the child is spawned as a process group leader so the group can be
signalled at once (`SIGTERM`, then `SIGKILL` after a grace period) with no `tree-kill`
dependency. It is also idempotent, and it never starts the command in order to stop it --
deemon's `--kill` spawned a daemon when none was running, launching the very thing it had been
asked to kill.

**`--restart` waits for the socket to be released** instead of sleeping 500 ms and hoping.

**Racing clients cannot produce two children.** A daemon probes for an incumbent, and binds the
socket, before spawning anything.

**Leftover socket files recover.** A file with nothing behind it is removed and rebound.

**Socket paths stay under the kernel limit.** macOS caps unix socket paths at 104 bytes and
counts the whole path; deemon-ng uses a 22 character base64url token instead of a 32 character
hex one, and falls back to the system temp directory rather than surfacing the kernel's `EINVAL`.

**Zero runtime dependencies.**

## Install

```sh
npm install --save-dev @softwarenerd/deemon-ng
```

The executable is named `deemon`, so scripts that already call `deemon` need no changes. Remove
the old `deemon` dependency in the same commit, since both provide the same binary name.

```diff
 "devDependencies": {
-  "deemon": "^1.13.6",
+  "@softwarenerd/deemon-ng": "^1.0.1",
 }
```

Existing deemon daemons are not adopted: the socket namespace differs on purpose, so a v1
daemon and a deemon-ng client cannot meet and speak mutually unintelligible protocols. Stop
any running deemon daemons, or let them be, and start fresh ones.

## Usage

```
deemon [OPTIONS] COMMAND [...ARGS]
```

Re-running the same command from the same directory attaches to the daemon already running it.
A command's identity is its path, its arguments and its working directory, so two checkouts of
the same repository get their own daemons.

| Option | Meaning |
|---|---|
| `--attach` | Attach to a running daemon; never start one |
| `--detach` | Start the daemon, wait until it is listening and settled, then exit |
| `--kill` | Stop the daemon running this command |
| `--restart` | Stop the daemon, wait for the socket, start a new one. Composes with `--detach` |
| `--status` | Report whether the daemon is running, and why it is not if it is not |
| `--logs` | Print the captured output of the last run |
| `--json` | Machine-readable output for `--status` |
| `--lines=N` | Lines of output for `--logs` (default 200) |
| `--timeout=MS` | How long to wait for a new daemon to listen (default 15000) |
| `--settle=MS` | How long `--detach` waits before confirming the command survived (default 750) |
| `--linger=MS` | How long a daemon serves after its command exits (default 10000) |
| `--wait` | Keep a finished daemon alive until a client collects its exit status |

While attached, Ctrl-C detaches and leaves the daemon running; Ctrl-D stops it.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success, or the command exited successfully |
| 1 | A failure described on stderr, or the command's own non-zero exit code |
| 2 | Bad usage |
| 3 | No daemon is running (`--status`, `--logs`) |

`--kill` exits 0 whether or not anything was running: it reports the desired state, not a
query. Use `--status` to ask.

### `--status --json`

```json
{
  "protocol": 1,
  "command": { "path": "npm", "args": ["run", "watch-client"], "cwd": "/Users/me/positron" },
  "state": "running",
  "daemonPid": 54881,
  "childPid": 54899,
  "startedAt": "2026-07-31T19:23:17.297Z",
  "uptimeMs": 91240,
  "bufferedBytes": 20481,
  "clients": 1,
  "logPath": "/Users/me/.local/state/deemon-ng/b9719bc1....log",
  "socketPath": "/var/folders/.../T/dng1-K6JqKyz76FYa-jE6sPXyBw.sock"
}
```

When nothing is running, `state` is `"stopped"` and `lastExit` carries the last run's outcome.

### Environment

| Variable | Meaning |
|---|---|
| `DEEMON_NG_STATE_DIR` | Where logs and daemon records live (default `$XDG_STATE_HOME/deemon-ng`) |
| `DEEMON_NG_SOCKET_DIR` | Where sockets are created (default `$XDG_RUNTIME_DIR` or the temp directory) |
| `DEEMON_NG_DEBUG` | Print stack traces for internal errors |

## Compatibility with deemon

The command line is a superset of deemon's, and these phrases are preserved verbatim because
tooling greps for them:

- `[deemon] Spawned build daemon. Press Ctrl-C to detach, Ctrl-D to kill.`
- `[deemon] Attached to running build daemon. Press Ctrl-C to detach, Ctrl-D to kill.`
- `[deemon] No daemon running.`
- `[deemon] Detached from build daemon.`
- `[deemon] Killed build daemon.`

The ordering contract is preserved too: on attach, replayed history arrives *before* the
readiness notice, so anything using that notice as the boundary between past and live output
keeps working.

`--wait` is accepted but is no longer needed for the common case; lingering is the default.

### Known limitation

A grandchild that puts *itself* into a new process group (`detached: true`) escapes a
process-group signal and is not stopped by `--kill`. This is the same class of gap that
`ps`-walking kill utilities have in reverse; ordinary tool chains (`npm`, `gulp`, `tsc`) do not
do this.

## Development

```sh
npm install
npm run build      # tsc to dist/
npm test           # node --test, ~13s
npm run watch      # tsc --watch
```

Requires Node 22 or newer.

## License

MIT. Portions of the command-line surface and wire semantics are derived from
[deemon](https://github.com/joaomoreno/deemon) by Joao Moreno, also MIT.
