/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Brian Lambert. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the Windows command line builder.
 *
 * Windows support cannot be exercised by running a command on a Mac, and a quoting bug is not
 * the kind that shows up as a crash -- it shows up as an argument quietly arriving as two. So
 * rather than assert against hand-written expected strings, these tests round-trip through
 * `parseCommandLine` below, a reference implementation of the parser the quoting targets. If
 * the pair agrees on a nasty corpus, the quoting is right for reasons, not by coincidence.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planSpawn, quoteArgument, windowsCommandLine } from '../dist/spawn.js';

/**
 * A reference implementation of `CommandLineToArgvW`, for arguments after the program name.
 *
 * Transcribed from the documented rules: whitespace separates arguments unless quoted; `2n`
 * backslashes before a quote mean `n` backslashes and a quote that toggles quoting; `2n+1` mean
 * `n` backslashes and a literal quote; backslashes elsewhere are literal.
 */
function parseCommandLine(line) {
	const args = [];
	let index = 0;

	while (index < line.length) {
		while (index < line.length && /\s/.test(line[index])) {
			index++;
		}
		if (index >= line.length) {
			break;
		}

		let current = '';
		let quoted = false;
		while (index < line.length) {
			if (!quoted && /\s/.test(line[index])) {
				break;
			}

			if (line[index] === '\\') {
				let backslashes = 0;
				while (line[index] === '\\') {
					backslashes++;
					index++;
				}
				if (line[index] === '"') {
					current += '\\'.repeat(backslashes >> 1);
					if (backslashes % 2 === 1) {
						current += '"';
					} else {
						quoted = !quoted;
					}
					index++;
				} else {
					current += '\\'.repeat(backslashes);
				}
				continue;
			}

			if (line[index] === '"') {
				quoted = !quoted;
				index++;
				continue;
			}

			current += line[index];
			index++;
		}
		args.push(current);
	}

	return args;
}

/** Arguments that have to survive, each with the reason it is here. */
const CORPUS = [
	['plain', 'run'],
	['a space, which unquoted concatenation split into two arguments', 'watch:all --mode dev'],
	['several spaces', 'a  b   c'],
	['an empty argument, which must not vanish', ''],
	['a double quote', 'say "hi"'],
	['a lone trailing quote', 'trailing"'],
	['a backslash, which is literal away from a quote', 'src\\main'],
	['a trailing backslash, which would otherwise escape the closing quote', 'C:\\dir\\'],
	['many trailing backslashes', 'C:\\dir\\\\\\'],
	['a backslash immediately before a quote', 'a\\"b'],
	['backslashes and quotes interleaved', 'a\\\\"b\\c\\\\\\"d'],
	['a UNC path', '\\\\server\\share\\file'],
	['cmd metacharacters, which unquoted cmd executed', 'a&b|c<d>e^f(g)h'],
	['a semicolon and comma, which cmd treats as argument separators', 'a;b,c'],
	['a percent sign, quoted so the shape at least survives', '50%'],
	['a path with a space, the original report', 'C:\\Program Files\\node\\node.exe'],
	['a tab', 'a\tb'],
	['non-ASCII text', 'ünïcødé — ok'],
	['something that looks like a flag with a quoted value', '--define=NAME="value with space"'],
];

describe('quoting an argument for a Windows command line', () => {
	for (const [reason, argument] of CORPUS) {
		it(`round-trips ${reason}`, () => {
			const line = quoteArgument(argument);
			assert.deepEqual(
				parseCommandLine(line),
				[argument],
				`quoted as ${line}`,
			);
		});
	}

	it('round-trips a whole argument list, which is where separators go wrong', () => {
		const args = CORPUS.map(([, argument]) => argument);
		const line = windowsCommandLine(args);
		assert.deepEqual(parseCommandLine(line), args, `built ${line}`);
	});

	it('round-trips every pair, since quoting can leak across a boundary', () => {
		for (const [, first] of CORPUS) {
			for (const [, second] of CORPUS) {
				const line = windowsCommandLine([first, second]);
				assert.deepEqual(
					parseCommandLine(line),
					[first, second],
					`${JSON.stringify([first, second])} built ${line}`,
				);
			}
		}
	});

	it('leaves no metacharacter outside a quoted region for cmd.exe to act on', () => {
		// Everything cmd.exe would otherwise interpret must fall inside quotes. Checking the
		// structure directly catches a regression that round-tripping alone would not: an
		// argument can parse back correctly and still have been executed by the shell first.
		for (const [, argument] of CORPUS) {
			const quoted = quoteArgument(argument);
			assert.ok(quoted.startsWith('"') && quoted.endsWith('"'), `not quoted: ${quoted}`);
			assert.equal(
				unquotedRegions(quoted).join(''),
				'',
				`characters left outside quotes in ${quoted}`,
			);
		}
	});
});

/** The parts of a command line cmd.exe would parse outside a quoted region. */
function unquotedRegions(line) {
	const regions = [];
	let quoted = false;
	for (let index = 0; index < line.length; index++) {
		// A quote preceded by an odd number of backslashes is data, not a delimiter.
		let backslashes = 0;
		while (line[index] === '\\') {
			backslashes++;
			index++;
		}
		if (line[index] === '"' && backslashes % 2 === 0) {
			quoted = !quoted;
			continue;
		}
		if (!quoted && line[index] !== undefined) {
			regions.push(line[index]);
		}
	}
	return regions;
}

describe('planning a spawn', () => {
	// The Windows branch is the point of the module, but its behaviour depends on PATHEXT and on
	// files that only exist there. What is checkable here is that POSIX is left alone: an argv
	// array, passed to `execvp` unchanged, with nothing that could reinterpret it.
	it('passes the command through untouched on POSIX', {
		skip: process.platform === 'win32' ? 'POSIX only' : false,
	}, () => {
		const command = { path: 'npm', args: ['run', 'watch:all --mode dev', 'a&b'], cwd: process.cwd() };
		const plan = planSpawn(command);

		assert.equal(plan.file, 'npm');
		assert.deepEqual(plan.args, ['run', 'watch:all --mode dev', 'a&b']);
		assert.equal(plan.windowsVerbatimArguments, false);
	});
});
