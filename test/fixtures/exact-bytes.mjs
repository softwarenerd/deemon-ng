// Writes an exact byte sequence with no trailing newline and exits 0. deemon's client withheld
// the final byte of every chunk to use as an exit code; this pins down that deemon-ng never
// does, whatever the chunk boundaries turn out to be.
process.stdout.write('ABC');
