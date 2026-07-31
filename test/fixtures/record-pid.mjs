// Appends its pid to the given file, then runs forever. Used to prove that racing clients
// produce exactly one supervised child.
import * as fs from 'node:fs';

fs.appendFileSync(process.argv[2], `${process.pid}\n`);
setInterval(() => { }, 1_000);
