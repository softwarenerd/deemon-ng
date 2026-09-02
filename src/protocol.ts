/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Brian Lambert. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { DeemonError, ExitCode } from './report.js';

/**
 * A command supervised by a daemon. The triple of path, args and cwd is the daemon's
 * identity: it determines the socket path, the log path and the state record path, so two
 * checkouts of the same repository never share a daemon.
 */
export interface Command {
	readonly path: string;
	readonly args: readonly string[];
	readonly cwd: string;
}

/**
 * Wire format version. Bumping it changes the socket namespace, so a client can never
 * speak a newer dialect at an older daemon that happens to still be listening.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Frame types. Every frame on the wire is `[type:u8][length:u32be][payload]`.
 *
 * The explicit framing is the fix for deemon's "last byte of the stream is the exit code"
 * convention, which both withheld a byte of real output and misread output bytes as exit
 * codes when a client disconnected from a healthy daemon.
 */
export enum FrameType {
	/** Client -> daemon. JSON {@link ControlMessage}. */
	Control = 1,
	/** Daemon -> client. Raw child stdout bytes. */
	Stdout = 2,
	/** Daemon -> client. Raw child stderr bytes. */
	Stderr = 3,
	/** Daemon -> client. JSON {@link ExitInfo}. The supervised child is gone. */
	Exited = 4,
	/** Daemon -> client. JSON {@link Status}. */
	Status = 5,
	/** Daemon -> client. UTF-8 text to relay to the user verbatim. */
	Notice = 6,
}

/** Requests a client can make of a daemon. */
export type ControlMessage =
	| {
		readonly kind: 'attach';
		/**
		 * True when this client spawned the daemon it is attaching to. The daemon uses it to
		 * pick the "Spawned" vs "Attached to running" notice, which is more reliable than
		 * deemon's 210ms timer for deciding whether an attach is a birth or a reconnect.
		 */
		readonly spawned: boolean;
	}
	| { readonly kind: 'kill' }
	| { readonly kind: 'status' };

/** How and when the supervised child exited. */
export interface ExitInfo {
	readonly code: number | null;
	readonly signal: string | null;
	/** True when the exit was requested via `--kill` or `--restart` rather than spontaneous. */
	readonly requested: boolean;
	/** ISO 8601 timestamp. */
	readonly at: string;
	/** Milliseconds between spawning the child and its exit. */
	readonly ranForMs: number;
}

/** A daemon's answer to `--status`. */
export interface Status {
	readonly protocol: number;
	readonly command: Command;
	readonly state: 'running' | 'exited';
	readonly daemonPid: number;
	readonly childPid: number | undefined;
	/** The process this daemon will not outlive, or undefined when it will outlive everything. */
	readonly ownerPid: number | undefined;
	readonly startedAt: string;
	readonly uptimeMs: number;
	readonly bufferedBytes: number;
	readonly clients: number;
	readonly logPath: string;
	readonly socketPath: string;
	readonly exit: ExitInfo | undefined;
}

const HEADER_SIZE = 5;

/**
 * Upper bound on a single frame. The daemon never emits frames this large (child output is
 * chunked as it arrives), so exceeding it means the stream is desynchronized or hostile.
 */
const MAX_FRAME_SIZE = 64 * 1024 * 1024;

/** Encodes one frame. */
export function encodeFrame(type: FrameType, payload?: Buffer | string): Buffer {
	const body = payload === undefined
		? Buffer.alloc(0)
		: (typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload);
	const frame = Buffer.allocUnsafe(HEADER_SIZE + body.length);
	frame[0] = type;
	frame.writeUInt32BE(body.length, 1);
	body.copy(frame, HEADER_SIZE);
	return frame;
}

/** Encodes one frame whose payload is JSON. */
export function encodeJsonFrame(type: FrameType, value: unknown): Buffer {
	return encodeFrame(type, JSON.stringify(value));
}

/** A decoded frame. `payload` may be a view onto the decoder's buffer; copy it to retain it. */
export interface Frame {
	readonly type: FrameType;
	readonly payload: Buffer;
}

/**
 * Incremental frame decoder. Socket reads split and coalesce arbitrarily, so every consumer
 * feeds chunks through one of these rather than assuming a read is a message.
 */
export class FrameDecoder {
	private buffer: Buffer = Buffer.alloc(0);

	/** Appends a chunk and returns every frame that is now complete. */
	push(chunk: Buffer): Frame[] {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

		const frames: Frame[] = [];
		let offset = 0;
		while (this.buffer.length - offset >= HEADER_SIZE) {
			const length = this.buffer.readUInt32BE(offset + 1);
			if (length > MAX_FRAME_SIZE) {
				throw new Error(`Protocol error: frame of ${length} bytes exceeds the ${MAX_FRAME_SIZE} byte limit.`);
			}
			if (this.buffer.length - offset - HEADER_SIZE < length) {
				break;
			}
			frames.push({
				type: this.buffer[offset] as FrameType,
				payload: this.buffer.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + length),
			});
			offset += HEADER_SIZE + length;
		}

		if (offset > 0) {
			this.buffer = this.buffer.subarray(offset);
		}
		return frames;
	}
}

/** Parses a JSON frame payload. */
export function decodeJson<T>(frame: Frame): T {
	return JSON.parse(frame.payload.toString('utf8')) as T;
}

/** The digest identifying a command. */
function commandDigest(command: Command): Buffer {
	return crypto
		.createHash('md5')
		.update(command.path)
		.update(command.args.toString())
		.update(command.cwd)
		.digest();
}

/** The stable hash identifying a command, used to name its files in the state directory. */
export function commandId(command: Command): string {
	return commandDigest(command).toString('hex');
}

/**
 * A compact form of {@link commandId} for use in socket paths.
 *
 * Unix socket paths are capped at 104 bytes on macOS and 108 on Linux, and the cap counts the
 * whole path. A 32 character hex id under a temp directory leaves almost no headroom, so the
 * same digest is encoded in base64url instead: 22 characters rather than 32, same collision
 * resistance.
 */
function socketToken(command: Command): string {
	return commandDigest(command).toString('base64url');
}

/** Renders a command the way a user typed it, for messages. */
export function formatCommand(command: Command): string {
	return [command.path, ...command.args].join(' ');
}

/**
 * Where sockets live. `DEEMON_NG_SOCKET_DIR` exists so tests (and anyone with a
 * pathologically long TMPDIR) can relocate them; macOS caps unix socket paths at ~104 bytes.
 */
export function socketDir(): string {
	return process.env['DEEMON_NG_SOCKET_DIR'] || process.env['XDG_RUNTIME_DIR'] || os.tmpdir();
}

/**
 * Longest unix socket path we will attempt. The real limits are 104 bytes on macOS and 108 on
 * Linux; staying under the smaller one keeps behaviour identical across both.
 */
const MAX_SOCKET_PATH_BYTES = 100;

/**
 * The socket (or named pipe) for a command.
 *
 * The `dng<n>` prefix deliberately differs from deemon's `daemon-<hash>.sock` so that during a
 * migration a still-running deemon daemon and a deemon-ng client cannot find each other and
 * speak mutually unintelligible protocols.
 */
export function socketPath(command: Command): string {
	const name = `dng${PROTOCOL_VERSION}-${socketToken(command)}.sock`;
	if (process.platform === 'win32') {
		return `\\\\.\\pipe\\${name}`;
	}

	const preferred = path.join(socketDir(), name);
	if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) {
		return preferred;
	}

	// The configured directory is too deep to hold a socket. Fall back to the system temp
	// directory rather than failing with the kernel's opaque EINVAL.
	const fallback = path.join(os.tmpdir(), name);
	if (Buffer.byteLength(fallback) <= MAX_SOCKET_PATH_BYTES) {
		return fallback;
	}

	throw new DeemonError(
		`No usable socket path: both ${preferred} and ${fallback} exceed the ${MAX_SOCKET_PATH_BYTES} byte limit for unix sockets.`,
		ExitCode.Failure,
		['Set DEEMON_NG_SOCKET_DIR to a shorter path.'],
	);
}
