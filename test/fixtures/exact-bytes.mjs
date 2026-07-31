// Writes an exact byte sequence with no trailing newline and exits 0. deemon withheld the
// final byte of every stream to use as an exit code, so this output arrived truncated.
process.stdout.write('ABC');
