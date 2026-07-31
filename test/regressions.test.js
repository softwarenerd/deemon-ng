/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Brian Lambert. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * One test per defect that made deemon report `connect ENOENT` instead of the truth. Each
 * test names the behaviour it locks in, so a regression says what broke rather than just
 * which assertion failed.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { delay, fixture, isAlive, run, runUntil, sandbox, status, stop, waitFor } from './helpers.js';

describe('a command that fails immediately', () => {
	it('reports the command failure, not a missing socket', async () => {
		const box = sandbox();
		const result = await run(box, ['node', fixture('fail-fast.mjs')]);

		assert.equal(result.code, 3, 'the command exit code must reach the caller');
		assert.match(result.output, /npm error Missing script: "watch"/, 'the command stderr must reach the caller');
		assert.match(result.output, /starting the watcher/, 'the command stdout must reach the caller');
		assert.doesNotMatch(result.output, /ENOENT/, 'a missing socket must never be reported');
		assert.doesNotMatch(result.output, /PipeConnectWrap|afterConnect/, 'no raw Error object may be printed');
	});

	it('leaves a record that explains the failure to whoever asks next', async () => {
		const box = sandbox();
		await run(box, ['--linger=0', 'node', fixture('fail-fast.mjs')]);
		await waitFor(async () => (await status(box, ['node', fixture('fail-fast.mjs')])).state === 'stopped',
			10_000, 'the daemon to finish lingering');

		const result = await run(box, ['--attach', 'node', fixture('fail-fast.mjs')]);

		assert.equal(result.code, 1);
		assert.match(result.output, /No daemon running\./, 'the legacy phrase tools grep for must survive');
		assert.match(result.output, /Last run: .*exited with code 3/, 'the reason must be recoverable after the daemon is gone');
		assert.match(result.output, /npm error Missing script/, 'the failing output must be quoted back');
		assert.match(result.output, /Full log: /, 'the full log must be discoverable');
	});

	it('is reported by --detach instead of being called a successful start', async () => {
		const box = sandbox();
		const result = await run(box, ['--detach', 'node', fixture('fail-fast.mjs')]);

		assert.equal(result.code, 3, 'a watcher that dies at once is not a successful start');
		assert.match(result.output, /did not stay running/);
		assert.match(result.output, /npm error Missing script/);
	});
});

describe('output fidelity', () => {
	it('relays the final byte of output', async () => {
		const box = sandbox();
		const result = await run(box, ['node', fixture('exact-bytes.mjs')]);

		assert.equal(result.code, 0);
		assert.match(result.stdout, /ABC/, 'the last byte must not be consumed as an exit code');
	});
});

describe('a healthy long-running command', () => {
	const box = sandbox();
	const command = ['node', fixture('watch.mjs'), 'healthy'];
	after(() => stop(box, command));

	it('starts once, and later clients attach to the same daemon', async () => {
		const started = await run(box, ['--detach', ...command]);
		assert.equal(started.code, 0);
		assert.match(started.output, /\[deemon\] Detached from build daemon\./);

		const first = await status(box, command);
		assert.equal(first.state, 'running');

		const again = await run(box, ['--detach', ...command]);
		assert.match(again.output, /\[deemon\] Attached to running build daemon\./);

		const second = await status(box, command);
		assert.equal(second.daemonPid, first.daemonPid, 'no second daemon may appear');
		assert.equal(second.childPid, first.childPid, 'no second child may appear');
	});

	it('replays the output it captured before the client existed', async () => {
		// `--attach` on a live daemon streams forever, so stop as soon as the replayed
		// compilation output and the readiness notice have both arrived.
		const { output } = await runUntil(box, ['--attach', ...command], [
			/Starting compilation\.\.\./,
			/Finished compilation with 0 errors \(healthy\)/,
			/\[deemon\] Attached to running build daemon\./,
		]);

		// The notice marks the boundary between replayed history and live output, which is how
		// tools tell one from the other. History must come first.
		assert.ok(
			output.indexOf('Finished compilation') < output.indexOf('[deemon] Attached to running'),
			`replayed output must precede the readiness notice:\n${output}`,
		);
	});
});

describe('racing clients', () => {
	it('produce exactly one supervised child', async () => {
		const box = sandbox();
		const pidFile = path.join(box.root, 'pids.txt');
		fs.writeFileSync(pidFile, '');
		const command = ['node', fixture('record-pid.mjs'), pidFile];

		const results = await Promise.all([
			run(box, ['--detach', ...command]),
			run(box, ['--detach', ...command]),
			run(box, ['--detach', ...command]),
		]);
		for (const result of results) {
			assert.equal(result.code, 0, result.output);
		}

		const pids = fs.readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean);
		assert.equal(pids.length, 1, `expected one child, got ${pids.length}: ${pids.join(', ')}`);

		await stop(box, command);
	});
});

describe('a leftover socket file', () => {
	it('does not stop a daemon from starting', async () => {
		const box = sandbox();
		const command = ['node', fixture('watch.mjs'), 'stale-socket'];

		// Stand in for what a SIGKILLed daemon leaves behind: the path exists, nothing answers.
		const offline = await status(box, command);
		assert.equal(offline.state, 'stopped');
		fs.writeFileSync(offline.socketPath, 'not a socket');

		const result = await run(box, ['--detach', ...command]);
		assert.equal(result.code, 0, result.output);
		assert.equal((await status(box, command)).state, 'running');

		await stop(box, command);
	});
});

describe('stopping a daemon', () => {
	it('takes the whole process tree with it', async () => {
		const box = sandbox();
		const pidFile = path.join(box.root, 'tree.json');
		const command = ['node', fixture('spawns-grandchild.mjs'), pidFile];

		await run(box, ['--detach', ...command]);
		await waitFor(() => fs.existsSync(pidFile), 10_000, 'the fixture to record its pids');
		const { child, grandchild } = JSON.parse(fs.readFileSync(pidFile, 'utf8'));

		const killed = await run(box, ['--kill', ...command]);
		assert.equal(killed.code, 0, killed.output);
		assert.match(killed.output, /\[deemon\] Killed build daemon\./);

		await waitFor(() => !isAlive(child), 10_000, 'the child to exit');
		await waitFor(() => !isAlive(grandchild), 10_000, 'the grandchild to exit');
	});

	it('confirms promptly rather than waiting out the linger window', async () => {
		const box = sandbox();
		const command = ['node', fixture('watch.mjs'), 'prompt-kill'];
		await run(box, ['--linger=10000', '--detach', ...command]);

		const started = Date.now();
		const killed = await run(box, ['--kill', ...command]);
		const elapsed = Date.now() - started;

		assert.equal(killed.code, 0);
		assert.ok(elapsed < 5_000, `--kill took ${elapsed}ms; it must not wait out the linger window`);
	});

	it('reports that there was nothing to stop', async () => {
		const box = sandbox();
		const command = ['node', fixture('watch.mjs'), 'nothing-to-stop'];

		const result = await run(box, ['--kill', ...command]);
		assert.equal(result.code, 3);
		assert.match(result.output, /No daemon running\./);
	});
});

describe('--restart', () => {
	it('replaces the running child', async () => {
		const box = sandbox();
		const command = ['node', fixture('watch.mjs'), 'restart'];
		await run(box, ['--detach', ...command]);
		const before = await status(box, command);

		const restarted = await run(box, ['--restart', '--detach', ...command]);
		assert.equal(restarted.code, 0, restarted.output);

		const after_ = await status(box, command);
		assert.equal(after_.state, 'running');
		assert.notEqual(after_.childPid, before.childPid, 'the child must actually be replaced');

		await stop(box, command);
	});
});

describe('a daemon that cannot start at all', () => {
	it('explains itself instead of reporting a missing socket', async () => {
		const box = sandbox();
		// A socket directory that is really a file makes bind fail with ENOTDIR, standing in for
		// any bootstrap crash. deemon discarded such failures entirely: `stdio: 'ignore'`. The
		// path is kept short so the socket-path length fallback does not rescue it.
		const notADirectory = path.join(os.tmpdir(), `dng-file-${process.pid}`);
		fs.writeFileSync(notADirectory, 'this is a file, not a directory');
		box.env.DEEMON_NG_SOCKET_DIR = notADirectory;

		const result = await run(box, ['node', fixture('watch.mjs'), 'no-socket-dir']);

		assert.equal(result.code, 1);
		assert.match(result.output, /Failed to start a daemon/);
		assert.match(result.output, /Daemon log: /, 'the daemon bootstrap log must be surfaced');
		assert.doesNotMatch(result.output, /PipeConnectWrap|afterConnect/, 'no raw Error object may be printed');
	});
});

describe('the phrases other tools grep for', () => {
	const box = sandbox();
	const command = ['node', fixture('watch.mjs'), 'compat'];
	after(() => stop(box, command));

	// Positron's build tooling matches these exact patterns. They are part of the contract.
	const READY = /\[deemon\] (Spawned|Attached to running) build daemon/;
	const MISSING = /\[deemon\] No daemon running/;

	it('announces readiness in the legacy form', async () => {
		const result = await run(box, ['--detach', ...command]);
		assert.equal(result.code, 0);
		const attached = await run(box, ['--status', ...command]);
		assert.equal(attached.code, 0);

		const spawned = await run(box, ['--kill', ...command]);
		assert.equal(spawned.code, 0);

		const fresh = await run(box, ['--linger=0', '--timeout=5000', 'node', fixture('exact-bytes.mjs')]);
		assert.match(fresh.output, READY);
	});

	it('reports absence in the legacy form', async () => {
		const result = await run(box, ['--attach', 'node', fixture('watch.mjs'), 'never-started']);
		assert.match(result.output, MISSING);
	});
});

describe('argument handling', () => {
	const box = sandbox();

	it('accepts a bare -- separator before and after options', async () => {
		const first = await run(box, ['--', '--detach', 'node', fixture('exact-bytes.mjs')]);
		assert.equal(first.code, 0, first.output);
		await delay(100);

		const second = await run(box, ['--attach', '--', 'node', fixture('exact-bytes.mjs')]);
		assert.ok(second.code === 0 || second.code === 1, second.output);
	});

	it('rejects an unknown option instead of ignoring it', async () => {
		const result = await run(box, ['--nonsense', 'node', fixture('exact-bytes.mjs')]);
		assert.equal(result.code, 2);
		assert.match(result.output, /Unknown option --nonsense/);
	});

	it('rejects modes that contradict each other', async () => {
		const result = await run(box, ['--attach', '--detach', 'node', fixture('exact-bytes.mjs')]);
		assert.equal(result.code, 2);
		assert.match(result.output, /cannot be combined/);
	});

	it('rejects a non-numeric timeout', async () => {
		const result = await run(box, ['--timeout=soon', 'node', fixture('exact-bytes.mjs')]);
		assert.equal(result.code, 2);
		assert.match(result.output, /--timeout must be a non-negative number/);
	});

	it('reports usage with no arguments', async () => {
		const result = await run(box, []);
		assert.equal(result.code, 2);
		assert.match(result.stdout, /Usage: deemon/);
	});
});

describe('two checkouts of the same command', () => {
	it('get separate daemons', async () => {
		const box = sandbox();
		const one = path.join(box.root, 'checkout-one');
		const two = path.join(box.root, 'checkout-two');
		fs.mkdirSync(one);
		fs.mkdirSync(two);
		const command = ['node', fixture('watch.mjs'), 'per-cwd'];

		await run(box, ['--detach', ...command], { cwd: one });
		await run(box, ['--detach', ...command], { cwd: two });

		const first = JSON.parse((await run(box, ['--status', '--json', ...command], { cwd: one })).stdout);
		const second = JSON.parse((await run(box, ['--status', '--json', ...command], { cwd: two })).stdout);

		assert.equal(first.state, 'running');
		assert.equal(second.state, 'running');
		assert.notEqual(first.daemonPid, second.daemonPid, 'each working directory owns its own daemon');

		await run(box, ['--kill', ...command], { cwd: one });
		await run(box, ['--kill', ...command], { cwd: two });
	});
});
