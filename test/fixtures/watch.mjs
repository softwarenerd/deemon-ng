// Stands in for a healthy watcher: emits a compilation cycle, then runs forever. Takes an
// optional label so different tests get different daemon identities.
const label = process.argv[2] ?? 'default';

console.log('Starting compilation...');
console.log(`Finished compilation with 0 errors (${label})`);

setInterval(() => console.log('still watching'), 500);
