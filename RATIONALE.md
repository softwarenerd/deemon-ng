# Why deemon-ng exists

A record of the decision to replace [deemon](https://github.com/joaomoreno/deemon) rather than
patch it, what the evidence was, and what it cost.

## Summary

Positron runs its five build watchers under deemon. On fresh clones, some or all of the build
tasks failed with a raw `connect ENOENT` dump naming a socket path. The message pointed at the
wrong thing: it meant *a watcher died and the daemon discarded its error message before anyone
could read it.*

The socket vanishing is a small bug. The reason it cost the team days is that deemon has no
mechanism, anywhere, for reporting why a supervised process died. That is not a bug to patch;
it is a capability the design does not have. deemon-ng was written to have it.

## The cost that prompted this

Three separate investigations of the same failure reached different conclusions, and the first
two were wrong:

1. First conclusion: the daemon was too slow to start, losing a 200 ms handshake race.
2. Second conclusion: same, plus a claim that `deemon@1.13.7` was byte-identical so upgrading
   was pointless. Half right, for the wrong reason.
3. Third conclusion, the correct one: startup time was never involved. Time-to-listen measures
   **36-39 ms even with 48 busy processes on an 18-core machine.** The socket was disappearing
   *after* being created, because the watcher had already died.

Reaching a wrong conclusion twice is the symptom worth taking seriously. The error message
named a socket and an `errno`, and the actual cause -- a missing npm script, an uncompiled
prerequisite -- appeared nowhere in it, or in any log, or on disk. Every investigation had to
start from scratch and reason backwards from a file path. That is the thing that cost days, and
no amount of care by the people investigating would have made it cheap.

## What actually happens

Measured on a Positron checkout by watching the socket file's lifetime while a fast-failing
command ran:

| Time | Event |
|---|---|
| 0 ms | Client connects, gets ENOENT (no daemon yet), spawns one with `stdio: 'ignore'` |
| 36 ms | Daemon binds the socket, spawns the command |
| 154 ms | **The command fails.** Daemon calls `server.close()`; Node unlinks the socket file |
| 200 ms | Client wakes from a hardcoded sleep, makes its one connection attempt, gets ENOENT |

The client prints the raw `Error` object because that second attempt sits outside deemon's
`try`/`catch` ([`main.ts:186`](https://github.com/joaomoreno/deemon/blob/main/src/main.ts#L186)
is inside the `catch` block, so its rejection lands in the top-level handler at `main.ts:309`).

Reproduced byte for byte, error frames and all, with nothing but `deemon npm run <script-that-
exits-1>`. It is not specific to Positron, or to fresh clones, or to any watcher. **Any command
that dies within roughly 165 ms produces it.** Fresh clones are simply when build scripts
genuinely fail for want of a prerequisite, which is also why it hit a different subset of
watchers each time and why retrying sometimes appeared to fix it.

## Why patching was not enough

### The one-line fix repairs the message, not the workflow

deemon already ships `--wait`, which makes the daemon hold its exit status instead of closing
the server. Adding it to Positron's `watch-*d` scripts turns the ENOENT into the command's real
error. That was verified first, before any code was written, and it works.

It leaves three things unfixed, all of which matter more than the message:

- **No post-mortem.** Once the daemon exits, the reason is gone. `deemon --attach` still answers
  `No daemon running.` and nothing else. `npm run build-ps` still prints `stopped` with no
  explanation. The expensive part of the problem survives the fix intact.
- **`--detach` still reports success for a watcher that is already dead.** Positron's
  `build-start.sh` uses `--detach`, so the command developers actually run prints
  `[name] started` for a watcher that died 100 ms earlier. `--wait` does not touch this.
- **`--wait` lingers forever.** The daemon holds the socket indefinitely waiting for a client
  that may never come, leaving an idle process per failed watcher.

### The upstream history shows the defect is in the design

The exit code is transmitted as the final byte of the output stream, so output and control share
one channel. That single decision has needed repeated correction upstream:

| Date | Commit |
|---|---|
| 2025-04-11 | `ensure exit code gets sent in --attach after --detach --wait` |
| 2025-04-13 | `fix exit code on windows` |
| 2025-04-14 | `make sure the last byte of regular output gets flushed eventually` |
| 2025-08-27 | `listen to end callback instead of setTimeout (#11)` |

Four corrective commits in five months, all of them shoring up the same conflation. Each was a
correct fix to a real symptom; none could address the cause, because the cause is the channel
design. (Credit where due: that third commit is why an attempt to demonstrate output loss in
1.13.6 failed -- see "What was not proven" below.)

Nine distinct defects were catalogued, four of them reproduced. They are not localised: they
live in the connect path, the daemon's exit path, the client's read loop, the argument parser,
and the error reporter. Fixing all of them touches every function in the file. At that point the
question is not whether to rewrite but whether to admit it.

### The requirement is not "fix the bug"

What the team needed was: *when a watcher dies, tell me why, and still tell me an hour later.*
That requires the outcome to be written somewhere durable. deemon keeps its output in one
in-memory buffer that dies with the process, and has no concept of on-disk state. Adding one is
not a patch; it is the larger half of deemon-ng (`state.ts`, plus `--status`, `--logs`, and the
explanation paths). Roughly 400 of the 1,218 code lines exist for this and nothing else.

### Why not send it upstream

deemon is a maintained, single-maintainer side project: 66 stars, 54 commits in six years, zero
open issues, last functional change 2025-08-27, last release 1.13.7 in March 2026. Nothing about
that is neglect -- PR #11 was merged and released same-day. But it means two things.

First, cadence: Positron's build entry point for every developer would be gated on someone
else's release schedule. Second, and more decisive: the on-disk state layer is a scope imposition
on a tool whose author deliberately kept it to 312 lines in one file. It would be rude to ask,
and wrong to expect.

**The minimal fixes should still go upstream.** The socket-unlink guard, a bounded connect retry,
and printing `err.message` are around ten lines between them, they benefit everyone using deemon,
and they cost us nothing to contribute. That is worth doing regardless of what Positron ships.

## What was verified

- **The mechanism**, by tracing the socket file's lifetime: created 36 ms, removed 154 ms,
  connect at 200 ms.
- **The reproduction**, byte for byte, from a trivial fast-failing npm script.
- **That startup latency is not the cause**: 36-39 ms to listen under 48-way CPU contention.
- **`deemon --kill` starts the command it was asked to kill**, on a cold repo, because `connect()`
  runs before the `--kill` branch and spawns a daemon. Confirmed by watching the command write
  its marker file.
- **Drop-in compatibility with Positron's real consumers**: `deemon-status.mts` and `build-ps.mts`
  work unmodified, because every reference in the repo is to the `deemon` binary, which deemon-ng
  also provides. The swap is two files: `package.json` and `package-lock.json`.
- **A fresh clone**, all four build tasks up, problem matchers resolving, no ENOENT.
- **22 regression tests**, one per defect, ~13 s, no leaked daemons.

## What was not proven

Stated plainly, because a case built on overclaims is worth less than a narrower true one:

- **Output loss from the last-byte channel could not be reproduced.** An earlier draft of the
  README asserted it; that was corrected. The design is fragile (`client.end(byte)` immediately
  followed by `client.destroy()`; a one-byte final chunk gets no flush timer) but in 1.13.6 the
  bytes arrive and the exit code is right. Item 7 of the defect list is a design objection, not
  a demonstrated failure.
- **The fresh-clone success does not isolate deemon-ng's contribution.** Positron
  [#15236](https://github.com/posit-dev/positron/pull/15236), which fixed a prerequisite-ordering
  race in `watch-extensions`, landed the same day. A fresh clone succeeding now may owe as much
  to that as to this. What the fresh clone does prove is that deemon-ng is a clean drop-in.
- **Two of five daemons stopped during the migration work with no recorded cause.** They were
  running under deemon v1 at the time, so there is no record. Fittingly, that is the exact gap
  this exists to close, but it means the incident cannot be attributed either way.

## What this costs

| | deemon | deemon-ng |
|---|---|---|
| Source files | 1 | 7 |
| Code lines | 255 | 1,218 |
| Tests | 0 | 22 |
| Runtime dependencies | 2 | 0 |

**4.8x the code, owned by us instead of by someone else.** That is the real price, and it is a
maintenance liability in a position where every developer's build depends on it. It is accepted
on the grounds that the alternative -- an unowned 312-line dependency at the same position, whose
failure mode costs days and cannot be diagnosed -- is the worse risk.

Mitigations: zero runtime dependencies, so nothing else can break it. A test per defect, so a
regression names itself. Byte-identical output phrases, so tooling that greps for
`[deemon] Spawned build daemon` keeps working. The binary is still called `deemon`, so reverting
is `git checkout main && npm install --ignore-scripts`.

## Alternatives considered

| Option | Why not |
|---|---|
| Add `--wait` to the `watch-*d` scripts | Free and it works, but leaves no post-mortem, still lets `--detach` report dead watchers as started, and leaks an idle daemon per failure |
| Wrapper script or `\|\| deemon ...` retry | Rejected early: the retry still prints the ENOENT dump, which is the thing to remove |
| Pin/upgrade deemon | 1.13.7 differs from 1.13.6 by a TypeScript bump; nothing relevant changes |
| Fork and minimally patch | The nine defects span every function in the file; the patch converges on a rewrite with worse comments |
| Upstream everything | Correct for the ten-line fix, wrong for a state layer the author deliberately excluded |

## How we will know it worked

The success condition is not "no more ENOENT." It is that **the next time a watcher dies, the
developer who hits it spends minutes, not hours.** Concretely: `npm run build-start` fails loudly
with the command's real error, `npm run build-ps` says why a daemon is not running, and
`deemon --logs npm run watch-extensions` still answers tomorrow.

One known gap remains outside this package:
[`deemon-status.mts`](https://github.com/posit-dev/positron/blob/main/scripts/deemon-status.mts)
exits 0 when no daemon is running, so `npm run build-check` passes with dead watchers, and its
`[deemon]`-line filter discards the new explanations. That is a separate small change to
Positron and should be made for any of this to be visible through `build-check`.
