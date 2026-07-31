/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Brian Lambert. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';

/** True if a process with this pid exists and we may signal it. */
export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means it exists but belongs to someone else, which still counts as alive.
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** Resolves once `pid` is gone, or after `timeoutMs`. Returns true if the process exited. */
export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isAlive(pid)) {
			return true;
		}
		await delay(20);
	}
	return !isAlive(pid);
}

/** Resolves after `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Terminates a process and everything it started, politely first.
 *
 * On POSIX the daemon spawns its child with `detached: true`, which makes the child a
 * process group leader, so signalling the negated pid reaches the whole tree without the
 * `tree-kill` dependency and without the pid-reuse hazard of walking `ps` output. Windows
 * has no process groups to signal, so it gets `taskkill /T`.
 */
export async function killTree(pid: number, graceMs = 5_000): Promise<void> {
	if (process.platform === 'win32') {
		await new Promise<void>(resolve => {
			cp.execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => resolve());
		});
		return;
	}

	if (!signalTree(pid, 'SIGTERM')) {
		return;
	}
	if (await waitForExit(pid, graceMs)) {
		return;
	}
	signalTree(pid, 'SIGKILL');
	await waitForExit(pid, 2_000);
}

/**
 * Signals a process group, falling back to the bare process. Returns false when there was
 * nothing left to signal.
 */
function signalTree(pid: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(-pid, signal);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
			// The group is gone. The leader may still be reachable directly if it was never
			// made a group leader (for instance when spawned without `detached`).
			try {
				process.kill(pid, signal);
				return true;
			} catch {
				return false;
			}
		}
		try {
			process.kill(pid, signal);
			return true;
		} catch {
			return false;
		}
	}
}
