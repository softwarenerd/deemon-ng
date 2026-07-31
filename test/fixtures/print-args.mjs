// Prints the arguments it received, as JSON, so a test can compare them with what was asked
// for. Windows has no argv: a command line is one string that each program splits itself, so
// this is the only way to tell whether an argument survived the trip through the daemon.
process.stdout.write(`${JSON.stringify(process.argv.slice(2))}\n`);
