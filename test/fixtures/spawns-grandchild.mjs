// Spawns a grandchild in its own process group and records both pids, to check that stopping
// a daemon takes the whole tree with it rather than orphaning the real work.
import * as cp from 'node:child_process';
import * as fs from 'node:fs';

const pidFile = process.argv[2];
const grandchild = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
	stdio: 'ignore',
});

fs.writeFileSync(pidFile, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
setInterval(() => { }, 1_000);
