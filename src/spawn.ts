/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Brian Lambert. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from './protocol.js';

/**
 * How to hand a {@link Command} to `child_process.spawn`.
 *
 * This exists because `shell: true` is not a usable way to run a user's command on Windows.
 * Node concatenates the argument array into one string and escapes nothing -- a hazard it now
 * warns about as DEP0190 -- so `deemon npm run "watch:all --mode dev"` arrived at the command
 * as five arguments rather than three, and an argument containing `&` or `|` was executed by
 * cmd.exe rather than passed along. The daemon builds the command line itself instead.
 */
export interface SpawnPlan {
	/** The executable to spawn. */
	readonly file: string;
	/** Arguments, already quoted when {@link windowsVerbatimArguments} is set. */
	readonly args: readonly string[];
	/**
	 * True when `args` is a command line we have quoted ourselves and Node must pass it through
	 * untouched rather than applying its own quoting on top.
	 */
	readonly windowsVerbatimArguments: boolean;
}

/**
 * Decides how to spawn a command.
 *
 * POSIX needs no help: `spawn` takes an argv array and passes it to `execvp` unchanged, so
 * there is no command line to quote and nothing can reinterpret an argument.
 *
 * Windows has no argv. Every process receives one string and splits it itself, so something
 * has to do the quoting, and whatever does it must also know whether cmd.exe is in the way:
 *
 * - A real executable (`.exe`, `.com`) is spawned directly, with Node doing the quoting. No
 *   shell is involved, which also means the pid we supervise and the exit code we report are
 *   the command's own rather than a wrapper's.
 * - Anything else that PATHEXT makes runnable -- `.cmd` and `.bat`, mainly, which is how
 *   `npm`, `npx` and `tsc` are installed -- has to go through cmd.exe, because a batch file is
 *   not a program image. Node has refused to spawn one without a shell since CVE-2024-27980.
 *   For those we build and quote the command line here.
 */
export function planSpawn(command: Command): SpawnPlan {
	if (process.platform !== 'win32') {
		return { file: command.path, args: command.args, windowsVerbatimArguments: false };
	}

	const resolved = resolveExecutable(command.path, command.cwd);

	// An unresolved command is passed through as the user typed it, so that the failure comes
	// from the spawn with a real ENOENT rather than from a guess made here.
	if (!resolved || isProgramImage(resolved)) {
		return {
			file: resolved ?? command.path,
			args: command.args,
			windowsVerbatimArguments: false,
		};
	}

	// `/d` skips AutoRun commands from the registry, which would otherwise run inside every
	// daemon. `/s` makes cmd strip exactly the outer pair of quotes and treat the rest
	// literally, which is what lets the quoting below survive intact.
	return {
		file: comspec(),
		args: ['/d', '/s', '/c', `"${windowsCommandLine([resolved, ...command.args])}"`],
		windowsVerbatimArguments: true,
	};
}

/**
 * Quotes and joins parts into a Windows command line.
 *
 * Exported for its own tests: this is the half of Windows support that cannot be exercised by
 * running anything on a developer's Mac, so it is verified by round-tripping through a
 * reference implementation of the parser instead.
 */
export function windowsCommandLine(parts: readonly string[]): string {
	return parts.map(quoteArgument).join(' ');
}

/**
 * Quotes one argument for a Windows command line.
 *
 * This is the inverse of `CommandLineToArgvW`, the parser the C runtime uses to split a
 * command line back into an argv, and therefore the one Node, Python and almost everything
 * else effectively uses. Its two rules are unobvious: a backslash is only an escape character
 * immediately before a quote, and a run of backslashes that ends at a quote must be doubled.
 *
 * Every argument is quoted, including the ones that would not strictly need it. That costs two
 * bytes and buys something worth more: cmd.exe never sees a metacharacter outside a quoted
 * region, so `&`, `|`, `<`, `>`, `^` and parentheses in an argument reach the command as text
 * instead of being executed.
 *
 * One hazard survives, and cannot be fixed here: cmd.exe expands `%VAR%` inside quotes, and
 * the command line offers no way to escape a `%`. It applies only to commands that go through
 * cmd.exe at all, which after {@link planSpawn} means batch files and not `.exe`s.
 */
export function quoteArgument(argument: string): string {
	let quoted = '"';

	for (let index = 0; index < argument.length; index++) {
		let backslashes = 0;
		while (index < argument.length && argument[index] === '\\') {
			backslashes++;
			index++;
		}

		if (index === argument.length) {
			// These backslashes now sit against the closing quote, so doubling them is what
			// stops them from escaping it.
			quoted += '\\'.repeat(backslashes * 2);
			break;
		}

		if (argument[index] === '"') {
			// Double the backslashes, then add one more to escape the quote itself.
			quoted += `${'\\'.repeat(backslashes * 2 + 1)}"`;
			continue;
		}

		// Away from a quote, backslashes are ordinary characters.
		quoted += '\\'.repeat(backslashes) + argument[index];
	}

	return `${quoted}"`;
}

/** True if Windows can hand this file to `CreateProcess` as it stands. */
function isProgramImage(file: string): boolean {
	return /\.(?:exe|com)$/i.test(file);
}

/**
 * The command interpreter.
 *
 * `/d /s /c` is cmd.exe syntax, so a `ComSpec` pointing at anything else would turn a working
 * command into a baffling one. Checking is cheaper than diagnosing that later.
 */
function comspec(): string {
	const configured = process.env['ComSpec'];
	return configured && /(?:^|[\\/])cmd(?:\.exe)?$/i.test(configured) ? configured : 'cmd.exe';
}

/** PATHEXT's default value, for the rare environment that does not set one. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * Finds the file a command name refers to, the way the platform would.
 *
 * The search order -- working directory first, then PATH -- is the one both cmd.exe and libuv
 * use, so resolving the name here does not change which file gets run. Only the decision of
 * whether cmd.exe is needed depends on the answer.
 */
function resolveExecutable(file: string, cwd: string): string | undefined {
	const extensions = (process.env['PATHEXT'] || DEFAULT_PATHEXT).split(';').filter(Boolean);

	// A separator or a drive letter makes it a path, which is not looked up in PATH.
	if (/[\\/]/.test(file) || /^[a-z]:/i.test(file)) {
		return findWithExtension(path.resolve(cwd, file), extensions);
	}

	const directories = [cwd, ...(process.env['PATH'] || '').split(path.delimiter).filter(Boolean)];
	for (const directory of directories) {
		const found = findWithExtension(path.resolve(cwd, directory, file), extensions);
		if (found) {
			return found;
		}
	}
	return undefined;
}

/** Returns `candidate`, or the first PATHEXT extension of it, that exists as a file. */
function findWithExtension(candidate: string, extensions: readonly string[]): string | undefined {
	// An extension the user typed is honoured as typed; `npm.cmd` must not become `npm.cmd.exe`.
	if (path.extname(candidate) && isFile(candidate)) {
		return candidate;
	}
	for (const extension of extensions) {
		if (isFile(candidate + extension)) {
			return candidate + extension;
		}
	}
	return isFile(candidate) ? candidate : undefined;
}

/** True if the path exists and is a file. */
function isFile(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}
