// Stands in for a watch script that dies immediately on a fresh clone, which is the shape of
// failure that deemon reported as `connect ENOENT`.
process.stdout.write('starting the watcher\n');
process.stderr.write('npm error Missing script: "watch"\n');
process.exit(3);
