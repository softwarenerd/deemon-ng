/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Brian Lambert. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Process exit codes this tool produces for its own reasons, as opposed to relaying a child's. */
export const ExitCode = {
	Ok: 0,
	Failure: 1,
	Usage: 2,
	NoDaemon: 3,
} as const;

/**
 * An error with a message written for the person reading the terminal.
 *
 * Everything that can go wrong is funnelled into one of these and printed through
 * {@link printError}. That is what makes it structurally impossible to reproduce deemon's
 * habit of dumping a raw `Error: connect ENOENT ...` object at a developer who has no way to
 * know it means "your build script failed".
 */
export class DeemonError extends Error {
	constructor(
		message: string,
		readonly exitCode: number = ExitCode.Failure,
		readonly details: readonly string[] = [],
	) {
		super(message);
		this.name = 'DeemonError';
	}
}

/**
 * Writes a `[deemon]`-prefixed notice to stdout.
 *
 * Every line is prefixed, not just the first, so quoted multi-line output stays visually
 * attributable to the tool rather than trailing off unprefixed.
 */
export function notice(text: string): void {
	process.stdout.write(prefixLines(text));
}

/** Writes a `[deemon]`-prefixed notice to stderr. */
export function noticeErr(text: string): void {
	process.stderr.write(prefixLines(text));
}

/** Prefixes every line of `text` with the tool tag. */
function prefixLines(text: string): string {
	return `${text.split('\n').map(line => `[deemon] ${line}`).join('\n')}\n`;
}

/** Writes indented supporting detail to stderr. */
export function detail(text: string): void {
	for (const line of text.split('\n')) {
		process.stderr.write(`         ${line}\n`);
	}
}

/** Prints an error and its details, and returns the exit code to use. */
export function printError(err: unknown): number {
	if (err instanceof DeemonError) {
		noticeErr(err.message);
		for (const line of err.details) {
			detail(line);
		}
		return err.exitCode;
	}

	const message = err instanceof Error ? err.message : String(err);
	noticeErr(`Unexpected internal error: ${message}`);
	if (process.env['DEEMON_NG_DEBUG'] && err instanceof Error && err.stack) {
		detail(err.stack);
	} else {
		detail('Set DEEMON_NG_DEBUG=1 to see the stack trace.');
	}
	return ExitCode.Failure;
}

/** Indents a block of text so it reads as supporting detail under a notice. */
export function indent(text: string, prefix = '  | '): string {
	return text.split('\n').map(line => `${prefix}${line}`).join('\n');
}
