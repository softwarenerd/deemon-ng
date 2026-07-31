/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Brian Lambert. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import {
	Command, ControlMessage, decodeJson, encodeFrame, encodeJsonFrame, ExitInfo,
	formatCommand, Frame, FrameDecoder, FrameType, PROTOCOL_VERSION, socketPath, Status,
} from './protocol.js';
import { delay, killTree } from './kill.js';
import { planSpawn } from './spawn.js';
import { ensureStateDir, logPath, rotateLogIfNeeded, writeRecord } from './state.js';

/** Knobs for {@link runDaemon}. */
export interface DaemonOptions {
	/**
	 * How long to keep serving after the supervised child exits, so that a client which is
	 * still completing its handshake learns the real exit code instead of finding the socket
	 * gone. This window is the direct fix for the ENOENT symptom.
	 */
	readonly lingerMs: number;
	/** Keep the corpse warm indefinitely until some client collects the exit status. */
	readonly waitForClient: boolean;
}

/** How much child output to keep in memory for replay to newly attached clients. */
const REPLAY_BUFFER_BYTES = 32 * 1024 * 1024;

/** Linger window after a stop that somebody asked for: just long enough to flush frames. */
const REQUESTED_EXIT_LINGER_MS = 500;

/** One chunk of captured output, tagged with the stream it came from. */
interface BufferedChunk {
	readonly type: FrameType.Stdout | FrameType.Stderr;
	readonly chunk: Buffer;
}

/** A connected client. */
interface Client {
	readonly socket: net.Socket;
	/** True once the client has asked to attach and is receiving live output. */
	live: boolean;
}

/**
 * Runs the daemon: owns the socket, supervises the child, and guarantees that the child's
 * fate is discoverable afterwards.
 *
 * Ordering matters here and is deliberate:
 *
 * 1. Probe for an existing daemon *before* doing anything else, so two clients racing to
 *    spawn a daemon for the same command cannot produce two copies of the child.
 * 2. Bind the socket *before* spawning the child, so the socket exists for the whole of the
 *    child's life rather than appearing partway through it.
 * 3. On child exit, persist the outcome and linger, rather than closing the server -- Node
 *    unlinks a unix socket when its server closes, which is exactly how deemon made a
 *    fast-failing child look like a missing socket.
 */
export async function runDaemon(command: Command, options: DaemonOptions): Promise<void> {
	const handle = socketPath(command);

	// (1) Defer to a daemon that is already serving this command.
	if (await probe(handle)) {
		return;
	}

	// (2) Bind. A socket file with nobody behind it is a leftover from a hard kill.
	const server = await bind(handle);
	if (!server) {
		return;
	}

	ensureStateDir();
	rotateLogIfNeeded(command);
	const log = fs.createWriteStream(logPath(command), { flags: 'a' });
	const startedAt = new Date();

	writeRecord({
		version: PROTOCOL_VERSION,
		command,
		socketPath: handle,
		logPath: logPath(command),
		daemonPid: process.pid,
		startedAt: startedAt.toISOString(),
	});

	// Never `shell: true`. See `planSpawn`: on Windows that hands the argument array to cmd.exe
	// as one unescaped string, which splits arguments containing spaces and executes the ones
	// containing `&` or `|`.
	const plan = planSpawn(command);
	const child = cp.spawn(plan.file, plan.args, {
		cwd: command.cwd,
		// POSIX: become a process group leader so the whole tree can be signalled at once.
		// Windows has no process groups; `killTree` uses `taskkill /T` there instead.
		detached: process.platform !== 'win32',
		windowsVerbatimArguments: plan.windowsVerbatimArguments,
		windowsHide: true,
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	const clients = new Set<Client>();
	const replay: BufferedChunk[] = [];
	let replayBytes = 0;
	let exit: ExitInfo | undefined;
	let killRequested = false;
	let lingerTimer: NodeJS.Timeout | undefined;
	/** Absolute time at which the daemon stops serving a finished child. */
	let lingerDeadline: number | undefined;
	/** True once some client has been handed the exit status. */
	let collected = false;

	const capture = (type: FrameType.Stdout | FrameType.Stderr) => (chunk: Buffer): void => {
		log.write(chunk);

		// Retain a copy: `chunk` belongs to the stream and may be recycled.
		replay.push({ type, chunk: Buffer.from(chunk) });
		replayBytes += chunk.length;
		while (replayBytes > REPLAY_BUFFER_BYTES && replay.length > 1) {
			replayBytes -= replay.shift()!.chunk.length;
		}

		const frame = encodeFrame(type, chunk);
		for (const client of clients) {
			if (client.live) {
				client.socket.write(frame);
			}
		}
	};

	child.stdout.on('data', capture(FrameType.Stdout));
	child.stderr.on('data', capture(FrameType.Stderr));

	/**
	 * Schedules the end of the daemon's afterlife.
	 *
	 * The deadline is absolute and set once. An earlier design recomputed it whenever a client
	 * disconnected, which meant anything polling the socket to watch for shutdown -- exactly
	 * what `--restart` does -- postponed that shutdown indefinitely.
	 */
	const armLinger = (): void => {
		if (!exit) {
			return;
		}
		if (options.waitForClient && !collected && !exit.requested) {
			// Hold the exit status indefinitely until somebody actually collects it.
			return;
		}
		if (lingerDeadline === undefined) {
			// A requested stop needs no window in which to explain itself; whoever asked for it
			// already knows why. Allow only enough time to flush the final frames.
			lingerDeadline = Date.now() + (exit.requested ? REQUESTED_EXIT_LINGER_MS : options.lingerMs);
		}
		clearTimeout(lingerTimer);
		lingerTimer = setTimeout(() => shutdown(), Math.max(0, lingerDeadline - Date.now()));
	};

	const shutdown = (): void => {
		clearTimeout(lingerTimer);
		for (const client of clients) {
			client.socket.destroy();
		}
		server.close();
		log.end();
		process.exit(exitCodeFor(exit));
	};

	child.on('close', (code, signal) => {
		exit = {
			code,
			signal,
			requested: killRequested,
			at: new Date().toISOString(),
			ranForMs: Date.now() - startedAt.getTime(),
		};

		// Persist before anything else. From this moment the outcome survives the daemon,
		// which is what lets a client that arrives minutes later still explain the failure.
		writeRecord({
			version: PROTOCOL_VERSION,
			command,
			socketPath: handle,
			logPath: logPath(command),
			daemonPid: process.pid,
			startedAt: startedAt.toISOString(),
			exit,
		});
		// Tell every client, attached or not. A `--kill` or `--status` client never asked for
		// the output stream but still needs to learn that the child is gone, or it waits out
		// the whole linger window for an answer that was never coming.
		const notice = encodeFrame(FrameType.Notice, `[deemon] ${describeExit(command, exit)}\n`);
		const exited = encodeJsonFrame(FrameType.Exited, exit);
		for (const client of clients) {
			if (client.live) {
				client.socket.write(notice);
			}
			client.socket.end(exited);
			collected = true;
		}

		armLinger();
	});

	server.on('connection', socket => {
		const client: Client = { socket, live: false };
		clients.add(client);

		const decoder = new FrameDecoder();
		socket.on('data', data => {
			let frames: Frame[];
			try {
				frames = decoder.push(data);
			} catch {
				socket.destroy();
				return;
			}
			for (const frame of frames) {
				if (frame.type === FrameType.Control) {
					handleControl(decodeJson<ControlMessage>(frame));
				}
			}
		});

		socket.on('error', () => socket.destroy());
		socket.on('close', () => {
			clients.delete(client);
			armLinger();
		});

		const handleControl = (message: ControlMessage): void => {
			switch (message.kind) {
				case 'status':
					socket.end(encodeJsonFrame(FrameType.Status, {
						protocol: PROTOCOL_VERSION,
						command,
						state: exit ? 'exited' : 'running',
						daemonPid: process.pid,
						childPid: exit ? undefined : child.pid,
						startedAt: startedAt.toISOString(),
						uptimeMs: Date.now() - startedAt.getTime(),
						bufferedBytes: replayBytes,
						// Only attached clients count; the connection asking for status does not.
						clients: [...clients].filter(candidate => candidate.live).length,
						logPath: logPath(command),
						socketPath: handle,
						exit,
					} satisfies Status));
					return;

				case 'kill':
					if (exit) {
						// Already dead. Say so explicitly: a client told only "it stopped" cannot
						// tell whether its own request did anything.
						socket.write(encodeFrame(FrameType.Notice, `[deemon] The daemon for \`${formatCommand(command)}\` had already stopped.\n`));
						socket.end(encodeJsonFrame(FrameType.Exited, exit));
						return;
					}
					killRequested = true;
					if (child.pid !== undefined) {
						void killTree(child.pid);
					}
					return;

				case 'attach': {
					// Replay history first, then the readiness notice, so that everything a
					// client sees before the notice is past and everything after is live. Tools
					// that parse the notice as a boundary marker depend on this ordering.
					for (const buffered of replay) {
						socket.write(encodeFrame(buffered.type, buffered.chunk));
					}
					socket.write(encodeFrame(FrameType.Notice, message.spawned
						? '[deemon] Spawned build daemon. Press Ctrl-C to detach, Ctrl-D to kill.\n'
						: '[deemon] Attached to running build daemon. Press Ctrl-C to detach, Ctrl-D to kill.\n'));

					if (exit) {
						socket.write(encodeFrame(FrameType.Notice, `[deemon] ${describeExit(command, exit)}\n`));
						socket.end(encodeJsonFrame(FrameType.Exited, exit));
						collected = true;
						armLinger();
						return;
					}

					client.live = true;
					return;
				}
			}
		};
	});

	const terminate = (): void => {
		if (child.pid !== undefined && !exit) {
			killRequested = true;
			void killTree(child.pid);
			return;
		}
		shutdown();
	};
	process.on('SIGTERM', terminate);
	process.on('SIGINT', terminate);
}

/** Human-readable one-liner about an exit, used in notices and logs. */
export function describeExit(command: Command, exit: ExitInfo): string {
	const how = exit.requested
		? 'was stopped on request'
		: exit.signal
			? `was killed by ${exit.signal}`
			: `exited with code ${exit.code}`;
	return `\`${formatCommand(command)}\` ${how} after ${formatDuration(exit.ranForMs)}.`;
}

/** Renders a duration the way a person reads one. */
export function formatDuration(ms: number): string {
	if (ms < 1_000) {
		return `${ms}ms`;
	}
	if (ms < 60_000) {
		return `${(ms / 1_000).toFixed(1)}s`;
	}
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1_000);
	return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

/** The process exit code a daemon should report for a given child outcome. */
function exitCodeFor(exit: ExitInfo | undefined): number {
	if (!exit || exit.requested) {
		return 0;
	}
	return exit.code ?? 1;
}

/** True if something is listening on `handle` right now. */
export async function probe(handle: string): Promise<boolean> {
	return new Promise(resolve => {
		const socket = net.createConnection(handle);
		const done = (result: boolean): void => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(result);
		};
		socket.once('connect', () => done(true));
		socket.once('error', () => done(false));
		socket.setTimeout(2_000, () => done(false));
	});
}

/**
 * Binds the socket, clearing a leftover socket file first.
 *
 * Returns undefined when another daemon won the race to bind, in which case this process has
 * nothing to do and must exit *without* having spawned a child.
 */
async function bind(handle: string): Promise<net.Server | undefined> {
	for (let attempt = 0; attempt < 2; attempt++) {
		removeSocketFile(handle);
		try {
			return await listen(handle);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
				throw err;
			}
			// Someone bound between our probe and our listen. If they are really there, they
			// own this command; if not, the file is stale and the next pass clears it.
			if (await probe(handle)) {
				return undefined;
			}
			await delay(20);
		}
	}
	return undefined;
}

/** Promisified `server.listen`. */
function listen(handle: string): Promise<net.Server> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(handle, () => {
			server.removeListener('error', reject);
			resolve(server);
		});
	});
}

/** Deletes a leftover socket file. Named pipes on Windows disappear with their process. */
function removeSocketFile(handle: string): void {
	if (process.platform === 'win32') {
		return;
	}
	try {
		fs.unlinkSync(handle);
	} catch {
		// Nothing there, which is the normal case.
	}
}
