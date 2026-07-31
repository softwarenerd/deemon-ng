#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Brian Lambert. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClientOptions, runClient } from './client.js';
import { runDaemon } from './daemon.js';
import { Command } from './protocol.js';
import { DeemonError, ExitCode, printError } from './report.js';

/** Everything the CLI accepts. */
interface Options extends ClientOptions {
	/** Internal: this process *is* the daemon. Set when the client re-invokes the CLI. */
	readonly daemon: boolean;
}

const USAGE = `Usage: deemon [OPTIONS] COMMAND [...ARGS]

Runs COMMAND in the background and attaches to it. Re-running the same COMMAND from the
same directory attaches to the daemon that is already running it.

Options:
  --attach        Attach to a running daemon; do not start one
  --detach        Start the daemon, wait until it is listening, then exit
  --kill          Stop the daemon running this command
  --restart       Stop the daemon, wait for it to release the socket, then start a new one
  --status        Report whether the daemon is running, and why it is not if it is not
  --logs          Print the captured output of this command's last run
  --json          Machine-readable output for --status
  --lines=N       Lines of output for --logs (default 200)
  --timeout=MS    How long to wait for a new daemon to start listening (default 15000)
  --settle=MS     How long --detach waits before confirming the command survived (default 750)
  --linger=MS     How long a daemon keeps serving after its command exits (default 10000)
  --wait          Keep a finished daemon alive until some client collects its exit status
  --help          Show this message
  --version       Show the version

Exit codes:
  0  success, or the command exited successfully
  1  a failure that is described on stderr, or the command's own non-zero exit code
  2  bad usage
  3  no daemon is running (--status, --kill, --logs)

Environment:
  DEEMON_NG_STATE_DIR   Where logs and daemon records are kept
  DEEMON_NG_SOCKET_DIR  Where sockets are created
  DEEMON_NG_DEBUG       Print stack traces for internal errors
`;

/** Options that take a value, as `--name=value`. */
const VALUED_OPTIONS = new Set(['timeout', 'linger', 'lines', 'settle']);

/** Options that are simple switches. */
const FLAG_OPTIONS = new Set([
	'daemon', 'attach', 'detach', 'kill', 'restart', 'status', 'logs', 'json', 'wait',
]);

/** The parsed command line. */
interface ParsedArgs {
	readonly command: Command;
	readonly options: Options;
}

/**
 * Splits argv into options and the command.
 *
 * The command begins at the first argument that does not start with `--`, which keeps
 * `deemon --attach -- npm run watch` and `deemon -- --detach npm run watch` working exactly
 * as they did with deemon; a bare `--` is accepted and ignored. Everything from the command
 * onwards is passed through untouched, so the command's own flags are never intercepted.
 */
function parseArgs(argv: readonly string[]): ParsedArgs {
	const commandIndex = argv.findIndex(arg => !arg.startsWith('--'));
	if (commandIndex === -1) {
		throw new DeemonError('No command given.', ExitCode.Usage, [USAGE]);
	}

	const flags = new Set<string>();
	const values = new Map<string, string>();

	for (const arg of argv.slice(0, commandIndex)) {
		if (arg === '--') {
			continue;
		}
		const [name, value] = splitOption(arg.slice(2));
		if (value !== undefined) {
			if (!VALUED_OPTIONS.has(name)) {
				throw new DeemonError(`Option --${name} does not take a value.`, ExitCode.Usage, [USAGE]);
			}
			values.set(name, value);
		} else if (FLAG_OPTIONS.has(name)) {
			flags.add(name);
		} else if (VALUED_OPTIONS.has(name)) {
			throw new DeemonError(`Option --${name} needs a value, as --${name}=N.`, ExitCode.Usage, [USAGE]);
		} else {
			throw new DeemonError(`Unknown option --${name}.`, ExitCode.Usage, [USAGE]);
		}
	}

	return {
		command: {
			path: argv[commandIndex],
			args: argv.slice(commandIndex + 1),
			cwd: process.cwd(),
		},
		options: {
			daemon: flags.has('daemon'),
			attach: flags.has('attach'),
			detach: flags.has('detach'),
			kill: flags.has('kill'),
			restart: flags.has('restart'),
			status: flags.has('status'),
			logs: flags.has('logs'),
			json: flags.has('json'),
			waitForClient: flags.has('wait'),
			timeoutMs: numberOption(values, 'timeout', 15_000),
			lingerMs: numberOption(values, 'linger', 10_000),
			lines: numberOption(values, 'lines', 200),
			settleMs: numberOption(values, 'settle', 750),
		},
	};
}

/** Splits `name=value` into its parts. */
function splitOption(text: string): [string, string | undefined] {
	const separator = text.indexOf('=');
	return separator === -1
		? [text, undefined]
		: [text.slice(0, separator), text.slice(separator + 1)];
}

/** Reads a numeric option, rejecting values that would silently misbehave. */
function numberOption(values: Map<string, string>, name: string, fallback: number): number {
	const raw = values.get(name);
	if (raw === undefined) {
		return fallback;
	}
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) {
		throw new DeemonError(`--${name} must be a non-negative number, not ${JSON.stringify(raw)}.`, ExitCode.Usage);
	}
	return value;
}

/**
 * Rejects combinations that cannot both be honoured, rather than quietly picking one.
 *
 * `--restart` is a modifier rather than a mode: it composes with the default attach-and-watch
 * behaviour and with `--detach`, which is what a build script that wants a clean daemon in
 * the background actually needs.
 */
function validate(options: Options): void {
	const modes = (['attach', 'detach', 'kill', 'status', 'logs'] as const).filter(name => options[name]);
	if (modes.length > 1) {
		throw new DeemonError(
			`Options ${modes.map(name => `--${name}`).join(' and ')} cannot be combined.`,
			ExitCode.Usage,
		);
	}

	const incompatibleWithRestart = (['attach', 'kill', 'status', 'logs'] as const).find(name => options[name]);
	if (options.restart && incompatibleWithRestart) {
		throw new DeemonError(
			`Options --restart and --${incompatibleWithRestart} cannot be combined.`,
			ExitCode.Usage,
		);
	}
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2);

	if (argv.includes('--help') || argv.length === 0) {
		process.stdout.write(USAGE);
		return argv.length === 0 ? ExitCode.Usage : ExitCode.Ok;
	}
	if (argv.includes('--version')) {
		process.stdout.write(`${await version()}\n`);
		return ExitCode.Ok;
	}

	const { command, options } = parseArgs(argv);
	validate(options);

	if (options.daemon) {
		await runDaemon(command, { lingerMs: options.lingerMs, waitForClient: options.waitForClient });
		// The daemon exits from its own shutdown path once its child is gone and the linger
		// window has closed. Returning here would tear down the server it just bound.
		return new Promise<number>(() => { });
	}

	return runClient(command, options);
}

/** Reads this package's version. */
async function version(): Promise<string> {
	const { readFileSync } = await import('node:fs');
	const { fileURLToPath } = await import('node:url');
	const { dirname, join } = await import('node:path');
	const packagePath = join(dirname(dirname(fileURLToPath(import.meta.url))), 'package.json');
	return (JSON.parse(readFileSync(packagePath, 'utf8')) as { version: string }).version;
}

// Every path out of the program funnels through printError, including the ones nobody
// anticipated. A raw Error object must never reach the terminal.
process.on('uncaughtException', err => process.exit(printError(err)));
process.on('unhandledRejection', err => process.exit(printError(err)));

main().then(
	code => { process.exitCode = code; },
	err => { process.exitCode = printError(err); },
);
