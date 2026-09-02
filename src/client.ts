/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Brian Lambert. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describeExit, formatDuration, probe } from './daemon.js';
import { delay } from './kill.js';
import { OWNER_PID_VAR, resolveOwner } from './owner.js';
import {
	Command, ControlMessage, decodeJson, encodeJsonFrame, ExitInfo, formatCommand,
	Frame, FrameDecoder, FrameType, socketPath, Status,
} from './protocol.js';
import { DeemonError, ExitCode, indent, notice } from './report.js';
import { bootstrapLogPath, ensureStateDir, excerptLog, logPath, readRecord, tailLog } from './state.js';

/** Knobs for the client half of the CLI. */
export interface ClientOptions {
	readonly kill: boolean;
	readonly restart: boolean;
	readonly detach: boolean;
	readonly attach: boolean;
	readonly status: boolean;
	readonly logs: boolean;
	readonly json: boolean;
	/** How long to wait for a freshly spawned daemon to start listening. */
	readonly timeoutMs: number;
	/** Passed through to the daemon: how long it lingers after its child exits. */
	readonly lingerMs: number;
	/** Passed through to the daemon: linger forever until a client collects the exit status. */
	readonly waitForClient: boolean;
	/** Lines of log to show for `--logs`. */
	readonly lines: number;
	/** How long `--detach` waits before confirming that the command is still alive. */
	readonly settleMs: number;
}

/**
 * How many lines of captured output to quote when explaining a failure.
 *
 * Generous on purpose: a command that dies during startup usually produces less than this in
 * total, so the whole thing is quoted and nothing important is elided.
 */
const EXPLAIN_EXCERPT_LINES = 24;

/** Ctrl-C, which detaches from the daemon and leaves it running. */
const CTRL_C = '\u0003';

/** Ctrl-D, which stops the daemon. */
const CTRL_D = '\u0004';

/** Runs the client half of the CLI. Returns the process exit code. */
export async function runClient(command: Command, options: ClientOptions): Promise<number> {
	if (options.logs) {
		return showLogs(command, options);
	}
	if (options.status) {
		return showStatus(command, options);
	}
	if (options.kill) {
		return killDaemon(command);
	}

	// `--restart` is a modifier, so it has to run before the mode that follows it, whether
	// that mode is `--detach` or the default attach-and-watch.
	if (options.restart) {
		await stopForRestart(command);
	}

	if (options.detach) {
		return detachDaemon(command, options);
	}

	let socket = await tryConnect(socketPath(command));
	let spawned = false;

	if (!socket) {
		if (options.attach) {
			// `--attach` promises never to start anything, so this is where the run ends. The
			// difference from deemon is that we can usually say *why* nothing is running.
			notice('No daemon running.');
			for (const line of explainAbsence(command)) {
				notice(line);
			}
			return ExitCode.Failure;
		}
		socket = await spawnAndConnect(command, options);
		spawned = true;
	}

	return streamUntilDone(socket, command, spawned);
}

/** Connects, or resolves undefined if nothing is listening. Never throws for the normal cases. */
async function tryConnect(handle: string): Promise<net.Socket | undefined> {
	return new Promise(resolve => {
		const socket = net.createConnection(handle);
		const onError = (): void => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(undefined);
		};
		socket.once('error', onError);
		socket.once('connect', () => {
			socket.removeListener('error', onError);
			resolve(socket);
		});
	});
}

/** The CLI entry point, which the daemon re-enters as `--daemon`. */
function selfPath(): string {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
}

/**
 * Starts a detached daemon.
 *
 * Its stdio goes to a log file rather than to `/dev/null`. deemon used `stdio: 'ignore'`,
 * which meant a daemon that crashed during bootstrap left no trace anywhere and the client
 * could only report that the socket was missing.
 *
 * The owner, if there is one, is resolved here and passed down as an already-decided pid. The
 * daemon cannot work it out for itself: it is about to be detached from this terminal, which
 * is the very thing it needs to identify.
 */
function spawnDaemon(command: Command, options: ClientOptions): cp.ChildProcess {
	ensureStateDir();
	const log = fs.openSync(bootstrapLogPath(command), 'a');
	try {
		const args = [selfPath(), '--daemon', `--linger=${options.lingerMs}`];
		if (options.waitForClient) {
			args.push('--wait');
		}
		args.push(command.path, ...command.args);

		// The client is the only authority on this, so the variable is always written, never
		// merely left alone. Passing our own environment through would hand the daemon a stale
		// or rejected pid -- a dead one included, which would stop it the moment it started.
		const env = { ...process.env };
		const owner = resolveOwner();
		if (owner) {
			env[OWNER_PID_VAR] = String(owner.pid);
		} else {
			delete env[OWNER_PID_VAR];
		}

		return cp.spawn(process.execPath, args, {
			cwd: command.cwd,
			detached: true,
			stdio: ['ignore', log, log],
			env,
		});
	} finally {
		fs.closeSync(log);
	}
}

/**
 * Spawns a daemon and waits for it to accept a connection.
 *
 * The wait is a bounded poll rather than deemon's single connection attempt behind a fixed
 * 200ms sleep, and it watches the daemon process at the same time, so a daemon that dies
 * during bootstrap is reported immediately instead of 200ms later as a missing socket.
 */
async function spawnAndConnect(command: Command, options: ClientOptions): Promise<net.Socket> {
	const handle = socketPath(command);
	const daemon = spawnDaemon(command, options);

	let daemonExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	daemon.once('exit', (code, signal) => { daemonExit = { code, signal }; });
	daemon.once('error', () => { daemonExit = { code: null, signal: null }; });

	const deadline = Date.now() + options.timeoutMs;
	try {
		while (true) {
			const socket = await tryConnect(handle);
			if (socket) {
				return socket;
			}

			if (daemonExit) {
				// A daemon that finds another daemon already serving this command exits 0
				// without binding, so give the incumbent a moment to answer before giving up.
				for (let attempt = 0; attempt < 10; attempt++) {
					await delay(20);
					const late = await tryConnect(handle);
					if (late) {
						return late;
					}
				}
				throw daemonBootstrapFailed(command, daemonExit);
			}

			if (Date.now() >= deadline) {
				throw new DeemonError(
					`Timed out after ${formatDuration(options.timeoutMs)} waiting for the daemon to listen on ${handle}.`,
					ExitCode.Failure,
					[
						`The daemon process (pid ${daemon.pid}) is still running, so it started but never bound the socket.`,
						`Daemon log: ${bootstrapLogPath(command)}`,
						`Raise the limit with --timeout=<ms> if this machine is genuinely that slow.`,
					],
				);
			}

			await delay(10);
		}
	} finally {
		daemon.unref();
	}
}

/** Builds the error for a daemon that exited before it could serve. */
function daemonBootstrapFailed(
	command: Command,
	daemonExit: { code: number | null; signal: NodeJS.Signals | null },
): DeemonError {
	const details: string[] = [];

	const record = readRecord(command);
	if (record?.exit) {
		// The daemon did bind and did run the command; the command itself failed and the
		// daemon finished lingering before we got there. Report the command's failure.
		details.push(`Last run: ${describeExit(command, record.exit)}`);
		const tail = excerptLog(command, EXPLAIN_EXCERPT_LINES);
		if (tail) {
			details.push('Last output:', indent(tail));
		}
		details.push(`Full log: ${logPath(command)}`);
		return new DeemonError(
			`\`${formatCommand(command)}\` exited before this client could attach.`,
			record.exit.code ?? ExitCode.Failure,
			details,
		);
	}

	const how = daemonExit.signal
		? `was killed by ${daemonExit.signal}`
		: daemonExit.code === null
			? 'could not be started at all'
			: `exited with code ${daemonExit.code}`;
	details.push(`The daemon process ${how} before it began listening.`);

	const bootstrap = tailFile(bootstrapLogPath(command), EXPLAIN_EXCERPT_LINES);
	if (bootstrap) {
		details.push('Daemon output:', indent(bootstrap));
	}
	details.push(`Daemon log: ${bootstrapLogPath(command)}`);

	return new DeemonError(
		`Failed to start a daemon for \`${formatCommand(command)}\`.`,
		ExitCode.Failure,
		details,
	);
}

/** Attaches and relays output until the daemon or the user ends the session. */
async function streamUntilDone(socket: net.Socket, command: Command, spawned: boolean): Promise<number> {
	const decoder = new FrameDecoder();
	let exit: ExitInfo | undefined;
	let detached = false;

	const send = (message: ControlMessage): void => {
		socket.write(encodeJsonFrame(FrameType.Control, message));
	};

	return new Promise<number>(resolve => {
		const finish = (code: number): void => {
			restoreStdin();
			socket.destroy();
			resolve(code);
		};

		const onKeypress = (key: string): void => {
			if (key === CTRL_C) {
				detached = true;
				notice('Detached from build daemon.');
				finish(ExitCode.Ok);
			} else if (key === CTRL_D) {
				notice('Killed build daemon.');
				send({ kind: 'kill' });
				finish(ExitCode.Ok);
			}
		};

		const restoreStdin = (): void => {
			process.stdin.removeListener('keypress', onKeypress);
			if (process.stdin.isTTY && process.stdin.setRawMode) {
				process.stdin.setRawMode(false);
			}
			process.stdin.pause();
		};

		if (process.stdin.isTTY) {
			readline.emitKeypressEvents(process.stdin);
			process.stdin.setRawMode?.(true);
			process.stdin.on('keypress', onKeypress);
		}

		socket.on('data', data => {
			let frames: Frame[];
			try {
				frames = decoder.push(data);
			} catch (err) {
				finish(printProtocolError(err));
				return;
			}
			for (const frame of frames) {
				relay(frame);
			}
		});

		const relay = (frame: Frame): void => {
			switch (frame.type) {
				// Child output is written through byte for byte. deemon withheld the final byte
				// of every stream to use as an exit code, which silently truncated output.
				case FrameType.Stdout:
				case FrameType.Notice:
					process.stdout.write(frame.payload);
					return;
				case FrameType.Stderr:
					process.stderr.write(frame.payload);
					return;
				case FrameType.Exited:
					exit = decodeJson<ExitInfo>(frame);
					return;
			}
		};

		socket.on('error', () => { /* Handled by 'close'. */ });

		socket.on('close', () => {
			if (detached) {
				return;
			}
			if (exit) {
				notice(`Build daemon exited with code ${exit.code ?? 1}.`);
				finish(exit.requested ? ExitCode.Ok : exit.code ?? ExitCode.Failure);
				return;
			}

			// The socket closed without an exit frame: the daemon vanished rather than
			// reporting. Say so plainly, and add whatever it managed to record.
			const details = explainAbsence(command);
			process.stdout.write(`[deemon] Lost the connection to the build daemon.\n`);
			for (const line of details) {
				notice(line);
			}
			finish(ExitCode.Failure);
		});

		send({ kind: 'attach', spawned });
	});
}

/** Reports a desynchronized stream. */
function printProtocolError(err: unknown): number {
	const message = err instanceof Error ? err.message : String(err);
	process.stderr.write(`[deemon] ${message}\n`);
	return ExitCode.Failure;
}

/**
 * Explains why no daemon is running, using the record the last daemon left behind.
 *
 * This is the payoff of persisting state: "No daemon running" stops being a dead end.
 */
function explainAbsence(command: Command): string[] {
	const record = readRecord(command);
	if (!record) {
		return [`No daemon has run \`${formatCommand(command)}\` from ${command.cwd} yet.`];
	}

	if (record.exit) {
		const lines = [
			`Last run: ${describeExit(command, record.exit)}`,
			`Stopped at ${new Date(record.exit.at).toLocaleString()}.`,
		];
		const tail = excerptLog(command, EXPLAIN_EXCERPT_LINES);
		if (tail) {
			lines.push('Last output:', indent(tail));
		}
		lines.push(`Full log: ${logPath(command)}`);
		return lines;
	}

	return [
		`A daemon (pid ${record.daemonPid}) started at ${new Date(record.startedAt).toLocaleString()} but recorded no exit,`,
		`so it was killed abruptly rather than shutting down. Full log: ${logPath(command)}`,
	];
}

/**
 * Implements `--kill`.
 *
 * Stopping something already stopped succeeds. The desired state has been reached, and a stop
 * script that runs twice should not fail the second time; `--status` is how you *ask* whether
 * something is running.
 */
async function killDaemon(command: Command): Promise<number> {
	const socket = await tryConnect(socketPath(command));
	if (!socket) {
		notice('No daemon running.');
		return ExitCode.Ok;
	}

	// Unlike deemon, wait for the daemon to confirm rather than firing and forgetting, so
	// that a script can kill and immediately restart without racing the teardown.
	return new Promise<number>(resolve => {
		let settled = false;
		const settle = (code: number, message: string): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			notice(message);
			resolve(code);
		};

		const timer = setTimeout(
			() => settle(ExitCode.Failure, 'Asked the build daemon to stop, but it did not confirm within 10s.'),
			10_000,
		);

		// The socket must be read, not merely held. A paused socket never processes the
		// daemon's FIN, so a client that only listens for 'close' waits forever for a
		// shutdown that already happened.
		const decoder = new FrameDecoder();
		let alreadyStopped = false;
		socket.on('data', data => {
			for (const frame of decoder.push(data)) {
				if (frame.type === FrameType.Notice) {
					// The daemon only sends a notice here when it had nothing left to kill.
					alreadyStopped = true;
					process.stdout.write(frame.payload);
				} else if (frame.type === FrameType.Exited) {
					settle(ExitCode.Ok, alreadyStopped ? 'Nothing left to stop.' : 'Killed build daemon.');
					return;
				}
			}
		});
		socket.on('close', () => settle(ExitCode.Ok, 'Killed build daemon.'));
		socket.on('error', () => { /* Handled by 'close'. */ });
		socket.write(encodeJsonFrame(FrameType.Control, { kind: 'kill' } satisfies ControlMessage));
	});
}

/** Kills any running daemon and waits for the socket to be released, for `--restart`. */
async function stopForRestart(command: Command): Promise<void> {
	const handle = socketPath(command);
	if (!await probe(handle)) {
		return;
	}
	await killDaemon(command);

	// deemon slept a flat 500ms here and hoped. Poll instead: the next bind must not race
	// the outgoing daemon's teardown.
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (!await probe(handle)) {
			return;
		}
		await delay(20);
	}
	throw new DeemonError(
		`The existing daemon for \`${formatCommand(command)}\` is still listening 15s after being asked to stop.`,
		ExitCode.Failure,
		[`Socket: ${handle}`],
	);
}

/**
 * Implements `--detach`.
 *
 * Two things separate this from deemon's version, and both matter to a script whose whole
 * job is to report whether the watchers came up:
 *
 * - It waits for the daemon to be *listening*, not merely spawned.
 * - It then waits `--settle` and re-checks, so a command that starts and immediately dies is
 *   reported as the failure it is instead of as a successful start.
 */
async function detachDaemon(command: Command, options: ClientOptions): Promise<number> {
	const existing = await requestStatus(command);
	if (existing?.state === 'running') {
		notice('Attached to running build daemon.');
		return ExitCode.Ok;
	}
	if (existing) {
		// A daemon whose child has already exited is lingering on its way out. Let it go
		// rather than reporting its corpse as a running daemon.
		await waitForSocketRelease(command);
	}

	const socket = await spawnAndConnect(command, options);
	socket.destroy();

	await delay(options.settleMs);
	const settled = await requestStatus(command);
	if (!settled || settled.state === 'exited') {
		const exit = settled?.exit ?? readRecord(command)?.exit;
		throw new DeemonError(
			`\`${formatCommand(command)}\` started but did not stay running.`,
			exit?.code ?? ExitCode.Failure,
			explainAbsence(command),
		);
	}

	notice('Detached from build daemon.');
	const owner = resolveOwner();
	if (owner) {
		// Worth saying out loud: a daemon that is going to stop on its own is a surprise if you
		// did not know the variable was set, and silence is how you find out the hard way.
		notice(`Auto-kill armed: this daemon stops when ${owner.how} (pid ${owner.pid}) exits.`);
	}
	if (options.waitForClient) {
		notice('Daemon will wait for a client to connect before exiting.');
	}
	return ExitCode.Ok;
}

/** Waits, bounded, for a lingering daemon to stop listening. */
async function waitForSocketRelease(command: Command): Promise<void> {
	const handle = socketPath(command);
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (!await probe(handle)) {
			return;
		}
		await delay(20);
	}
	throw new DeemonError(
		`A daemon for \`${formatCommand(command)}\` is still holding ${handle} after 15s.`,
		ExitCode.Failure,
		[`Stop it with: deemon --kill ${formatCommand(command)}`],
	);
}

/** Implements `--status`. */
async function showStatus(command: Command, options: ClientOptions): Promise<number> {
	const status = await requestStatus(command);

	if (options.json) {
		process.stdout.write(`${JSON.stringify(status ?? offlineStatus(command), undefined, '\t')}\n`);
		return status && status.state === 'running' ? ExitCode.Ok : ExitCode.NoDaemon;
	}

	if (status?.state === 'running') {
		notice(`\`${formatCommand(command)}\` is running.`);
		notice(`Daemon pid ${status.daemonPid}, child pid ${status.childPid}, up ${formatDuration(status.uptimeMs)}, ${status.clients} client(s).`);
		if (status.ownerPid !== undefined) {
			// Only the pid, not the phrase `--detach` prints: the daemon was told which process
			// to follow and nothing about why, and a later client has no way to recover the
			// reasoning of a client that has long since exited.
			notice(`Auto-kill armed: this daemon stops when pid ${status.ownerPid} exits.`);
		}
		notice(`Log: ${status.logPath}`);
		return ExitCode.Ok;
	}

	notice('No daemon running.');
	for (const line of explainAbsence(command)) {
		notice(line);
	}
	return ExitCode.NoDaemon;
}

/** Asks a live daemon for its status, or resolves undefined if none is listening. */
async function requestStatus(command: Command): Promise<Status | undefined> {
	const socket = await tryConnect(socketPath(command));
	if (!socket) {
		return undefined;
	}

	return new Promise<Status | undefined>(resolve => {
		const decoder = new FrameDecoder();
		const timer = setTimeout(() => { socket.destroy(); resolve(undefined); }, 5_000);
		const done = (status: Status | undefined): void => {
			clearTimeout(timer);
			socket.destroy();
			resolve(status);
		};

		socket.on('data', data => {
			for (const frame of decoder.push(data)) {
				if (frame.type === FrameType.Status) {
					done(decodeJson<Status>(frame));
					return;
				}
			}
		});
		socket.on('error', () => done(undefined));
		socket.on('close', () => done(undefined));
		socket.write(encodeJsonFrame(FrameType.Control, { kind: 'status' } satisfies ControlMessage));
	});
}

/** The `--status --json` shape for a command with no live daemon. */
function offlineStatus(command: Command): Record<string, unknown> {
	const record = readRecord(command);
	return {
		command,
		state: 'stopped',
		logPath: logPath(command),
		socketPath: socketPath(command),
		lastStartedAt: record?.startedAt,
		lastExit: record?.exit,
	};
}

/** Implements `--logs`. */
function showLogs(command: Command, options: ClientOptions): number {
	const tail = tailLog(command, options.lines);
	if (!tail) {
		notice(`No output has been captured for \`${formatCommand(command)}\` yet.`);
		notice(`Expected log: ${logPath(command)}`);
		return ExitCode.NoDaemon;
	}
	process.stdout.write(`${tail}\n`);
	return ExitCode.Ok;
}

/** Returns the last `lines` lines of an arbitrary file, or an empty string. */
function tailFile(file: string, lines: number): string {
	try {
		const all = fs.readFileSync(file, 'utf8').replace(/\n$/, '').split('\n');
		return all.slice(Math.max(0, all.length - lines)).join('\n');
	} catch {
		return '';
	}
}
