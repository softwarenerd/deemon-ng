/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Brian Lambert. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The built CLI under test. */
export const CLI = path.join(here, '..', 'dist', 'cli.js');

/** Directory holding the child-process fixtures. */
export const FIXTURES = path.join(here, 'fixtures');

/**
 * Creates an isolated sandbox: its own state directory (logs and records) and its own socket
 * directory, so tests cannot see each other's daemons and a failure cannot leak into the
 * developer's real daemons.
 */
export function sandbox() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dng-test-'));
	const stateDir = path.join(root, 'state');
	const socketDir = path.join(root, 'sock');
	fs.mkdirSync(stateDir, { recursive: true });
	fs.mkdirSync(socketDir, { recursive: true });

	return {
		root,
		stateDir,
		socketDir,
		env: {
			...process.env,
			DEEMON_NG_STATE_DIR: stateDir,
			DEEMON_NG_SOCKET_DIR: socketDir,
		},
	};
}

/** Runs the CLI to completion and captures everything it said. */
export function run(box, args, { timeoutMs = 30_000, cwd = box.root } = {}) {
	return new Promise((resolve, reject) => {
		const child = cp.spawn(process.execPath, [CLI, ...args], { cwd, env: box.env });

		let stdout = '';
		let stderr = '';
		child.stdout.on('data', data => { stdout += data; });
		child.stderr.on('data', data => { stderr += data; });

		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error(`deemon ${args.join(' ')} did not finish within ${timeoutMs}ms.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
		}, timeoutMs);

		child.on('error', reject);
		child.on('close', code => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr, output: stdout + stderr });
		});
	});
}

/**
 * Runs the CLI until its output matches every pattern, then stops it.
 *
 * For commands that stream forever, such as attaching to a healthy watcher, waiting for the
 * expected output beats waiting for a timeout.
 */
export function runUntil(box, args, patterns, { timeoutMs = 20_000, cwd = box.root } = {}) {
	return new Promise((resolve, reject) => {
		const child = cp.spawn(process.execPath, [CLI, ...args], { cwd, env: box.env });

		let output = '';
		const check = () => {
			if (patterns.every(pattern => pattern.test(output))) {
				clearTimeout(timer);
				child.kill('SIGKILL');
				resolve({ output });
			}
		};
		child.stdout.on('data', data => { output += data; check(); });
		child.stderr.on('data', data => { output += data; check(); });

		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			const missing = patterns.filter(pattern => !pattern.test(output));
			reject(new Error(`deemon ${args.join(' ')} never produced ${missing.join(', ')} within ${timeoutMs}ms.\noutput:\n${output}`));
		}, timeoutMs);

		child.on('error', reject);
		child.on('close', () => {
			clearTimeout(timer);
			const missing = patterns.filter(pattern => !pattern.test(output));
			if (missing.length === 0) {
				resolve({ output });
			} else {
				reject(new Error(`deemon ${args.join(' ')} exited before producing ${missing.join(', ')}.\noutput:\n${output}`));
			}
		});
	});
}

/** Path of a fixture script. */
export function fixture(name) {
	return path.join(FIXTURES, name);
}

/** Reads `--status --json` for a command. */
export async function status(box, command) {
	const result = await run(box, ['--status', '--json', ...command]);
	return JSON.parse(result.stdout);
}

/** Stops a daemon, ignoring the case where it is already gone. */
export async function stop(box, command) {
	await run(box, ['--kill', ...command]).catch(() => undefined);
}

/** Resolves after `ms` milliseconds. */
export function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** True if a process is still around. */
export function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === 'EPERM';
	}
}

/** Polls `predicate` until it returns true, or throws when `timeoutMs` elapses. */
export async function waitFor(predicate, timeoutMs = 10_000, description = 'condition') {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) {
			return;
		}
		await delay(25);
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}.`);
}
