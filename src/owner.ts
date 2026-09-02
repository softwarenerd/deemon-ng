/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Brian Lambert. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import { isAlive } from './kill.js';

/** The process a daemon's life is tied to. */
export interface Owner {
	readonly pid: number;
	/** Noun phrase naming what was chosen, for the notice `--detach` prints. */
	readonly how: string;
}

/**
 * Carries the owner the client resolved through to the daemon it spawns.
 *
 * The daemon never resolves an owner itself. It is spawned detached, with no controlling
 * terminal and no ancestry worth walking, so the only process that can answer the question is
 * the client. Setting this by hand also works, and overrides the automatic choice.
 */
export const OWNER_PID_VAR = 'DEEMON_NG_OWNER_PID';

/** Asks for owner tracking in the first place. */
const AUTO_KILL_VAR = 'DEEMON_AUTO_KILL';

/** Values of {@link AUTO_KILL_VAR} that mean yes. Anything else, including unset, means no. */
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Cached across a run: a process cannot change which session it belongs to. */
let cached: Owner | undefined;
let resolved = false;

/**
 * Decides which process this daemon should not outlive, or undefined to live forever as
 * before.
 *
 * Owner tracking is off unless asked for, because outliving the shell that started it is the
 * entire point of a build daemon most of the time. It becomes a nuisance in one specific
 * situation -- an editor window open on a checkout, being closed and reopened on another
 * branch -- which is what `DEEMON_AUTO_KILL` is for.
 */
export function resolveOwner(): Owner | undefined {
	if (!resolved) {
		resolved = true;
		cached = chooseOwner();
	}
	return cached;
}

/** The owner a client already chose, as read by the daemon that client spawned. */
export function inheritedOwnerPid(): number | undefined {
	return readPid(process.env[OWNER_PID_VAR]);
}

/** {@link resolveOwner} without the cache. */
function chooseOwner(): Owner | undefined {
	// An explicit pid is a deliberate instruction and wins outright, including over the
	// question of whether tracking was asked for at all.
	const explicit = readPid(process.env[OWNER_PID_VAR]);
	if (explicit !== undefined) {
		return isAlive(explicit)
			? { pid: explicit, how: `the process named by ${OWNER_PID_VAR}` }
			: undefined;
	}

	if (!TRUTHY.has((process.env[AUTO_KILL_VAR] ?? '').trim().toLowerCase())) {
		return undefined;
	}

	const leader = sessionLeader();
	if (leader !== undefined) {
		return { pid: leader, how: 'the terminal session that started it' };
	}

	// No terminal session, so this came from something like an editor's extension host. Its
	// window cannot be identified from out here, but the application can, which at least means
	// the daemons do not outlive the editor entirely.
	const editor = readPid(process.env['VSCODE_PID']);
	if (editor !== undefined && isAlive(editor)) {
		return { pid: editor, how: 'the editor that started it' };
	}

	return undefined;
}

/** One row of the process table, which is all of it we need. */
interface ProcessEntry {
	readonly ppid: number;
	readonly tty: string;
}

/**
 * The leader of this process's terminal session: the outermost ancestor still sharing our
 * controlling terminal.
 *
 * That process is the shell behind an editor's integrated terminal tab, or `login` behind a
 * terminal emulator window, and it is what dies when the window holding it closes. An editor
 * that reloads a window rather than closing it keeps its terminal processes alive on purpose,
 * so following the session leader distinguishes a close from a reload without having to ask
 * the editor anything.
 *
 * The ancestry is walked rather than asked for directly because the session id is not portably
 * available: `ps -o sess=` reports a kernel address on macOS, not a pid.
 */
function sessionLeader(): number | undefined {
	if (process.platform === 'win32') {
		// No controlling terminals to inherit, so there is no session here to follow.
		return undefined;
	}

	const table = processTable();
	const self = table.get(process.pid);
	if (!self || !isTerminal(self.tty)) {
		// Started by something that is not a terminal at all: an extension host, a CI runner,
		// a launchd job. There is no session whose lifetime would mean anything.
		return undefined;
	}

	let leader = process.pid;
	const seen = new Set<number>([leader]);
	while (true) {
		const ppid = table.get(leader)?.ppid;
		if (ppid === undefined || seen.has(ppid)) {
			// Reached the top, or `ps` handed us a cycle. Either way, stop walking.
			return leader;
		}
		const parent = table.get(ppid);
		if (!parent || parent.tty !== self.tty) {
			// The parent is outside our terminal session -- the pty host, or init. The process
			// we are standing on is the leader.
			return leader;
		}
		seen.add(ppid);
		leader = ppid;
	}
}

/**
 * Reads the whole process table in one `ps` call.
 *
 * Walking the ancestry one `ps -p` at a time would be several execs deep on every daemon
 * start, for a table that is cheap to read whole.
 */
function processTable(): Map<number, ProcessEntry> {
	const table = new Map<number, ProcessEntry>();

	let output: string;
	try {
		output = cp.execFileSync('ps', ['-Ao', 'pid=,ppid=,tty='], {
			encoding: 'utf8',
			timeout: 5_000,
			stdio: ['ignore', 'pipe', 'ignore'],
		});
	} catch {
		// No `ps`, or it failed. Owner tracking is an opt-in convenience, and not having it is
		// no reason to refuse to start a daemon.
		return table;
	}

	for (const line of output.split('\n')) {
		const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
		if (row) {
			table.set(Number(row[1]), { ppid: Number(row[2]), tty: row[3] });
		}
	}
	return table;
}

/** True if a `ps` TTY column names a real terminal rather than "no controlling terminal". */
function isTerminal(tty: string): boolean {
	// macOS prints `??`, Linux prints `?`, and both print `-` in some configurations.
	return tty !== '?' && tty !== '??' && tty !== '-';
}

/** Reads a pid from an environment variable, rejecting anything that is not one. */
function readPid(raw: string | undefined): number | undefined {
	const value = Number(raw);
	return Number.isInteger(value) && value > 0 ? value : undefined;
}
