/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Brian Lambert. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command, commandId, ExitInfo, PROTOCOL_VERSION } from './protocol.js';

/**
 * What a daemon leaves on disk about itself.
 *
 * This record is the whole reason a failure can no longer vanish. deemon kept a daemon's
 * output only in that daemon's memory, so a child that died before anyone attached took its
 * error message with it and every later probe could report nothing but "No daemon running".
 * The record outlives the daemon, so the next client can say what happened and when.
 */
export interface DaemonRecord {
	readonly version: number;
	readonly command: Command;
	readonly socketPath: string;
	readonly logPath: string;
	readonly daemonPid: number;
	/** ISO 8601 timestamp of when the daemon began listening. */
	readonly startedAt: string;
	/** Present once the supervised child has exited. */
	readonly exit?: ExitInfo;
}

/** Root of the on-disk state. Overridable with `DEEMON_NG_STATE_DIR` (tests rely on this). */
export function stateDir(): string {
	return process.env['DEEMON_NG_STATE_DIR']
		|| path.join(process.env['XDG_STATE_HOME'] || path.join(os.homedir(), '.local', 'state'), 'deemon-ng');
}

/** Creates the state directory if needed and returns it. */
export function ensureStateDir(): string {
	const dir = stateDir();
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** Path of the JSON record describing a command's daemon. */
export function recordPath(command: Command): string {
	return path.join(stateDir(), `${commandId(command)}.json`);
}

/** Path of the log holding a command's captured output. */
export function logPath(command: Command): string {
	return path.join(stateDir(), `${commandId(command)}.log`);
}

/** Path of the log holding the daemon's own bootstrap output (crashes before it can serve). */
export function bootstrapLogPath(command: Command): string {
	return path.join(stateDir(), `${commandId(command)}.daemon.log`);
}

/** Reads a command's record, or undefined if there is none or it is unreadable. */
export function readRecord(command: Command): DaemonRecord | undefined {
	try {
		const record = JSON.parse(fs.readFileSync(recordPath(command), 'utf8')) as DaemonRecord;
		return record.version === PROTOCOL_VERSION ? record : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Writes a record. The write goes to a sibling temp file and is renamed into place so a
 * client can never read a half-written record.
 */
export function writeRecord(record: DaemonRecord): void {
	ensureStateDir();
	const target = recordPath(record.command);
	const temp = `${target}.${process.pid}.tmp`;
	fs.writeFileSync(temp, JSON.stringify(record, undefined, '\t'));
	fs.renameSync(temp, target);
}

/** Maximum size of a command's log before it is rotated to `<name>.log.old`. */
const LOG_ROTATE_BYTES = 32 * 1024 * 1024;

/** Rotates a command's log if it has grown past {@link LOG_ROTATE_BYTES}. */
export function rotateLogIfNeeded(command: Command): void {
	const target = logPath(command);
	try {
		if (fs.statSync(target).size > LOG_ROTATE_BYTES) {
			fs.renameSync(target, `${target}.old`);
		}
	} catch {
		// No log yet, or it vanished underneath us. Either way there is nothing to rotate.
	}
}

/** Returns the last `lines` lines of a command's log, or an empty string if there is none. */
export function tailLog(command: Command, lines: number): string {
	const all = readLogLines(command);
	return all.slice(Math.max(0, all.length - lines)).join('\n');
}

/**
 * Returns a readable excerpt of a command's log: the beginning, an elision, and the end.
 *
 * A plain tail is the wrong shape for a command that failed on startup, where the useful line
 * ("Error: Cannot find module ...") is at the top and the tail is stack frames. Quoting both
 * ends keeps the headline and the last word without burying either.
 */
export function excerptLog(command: Command, maxLines: number): string {
	const all = readLogLines(command);
	if (all.length <= maxLines) {
		return all.join('\n');
	}

	const head = Math.ceil((maxLines - 1) / 2);
	const tail = maxLines - 1 - head;
	return [
		...all.slice(0, head),
		`... ${all.length - head - tail} more lines ...`,
		...all.slice(all.length - tail),
	].join('\n');
}

/** Reads a command's log as lines, or an empty array if there is none. */
function readLogLines(command: Command): string[] {
	try {
		return fs.readFileSync(logPath(command), 'utf8').replace(/\n$/, '').split('\n');
	} catch {
		return [];
	}
}
