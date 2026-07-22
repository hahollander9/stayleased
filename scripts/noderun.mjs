// Portable Node launcher: adds --experimental-strip-types only when this Node
// still wants it (Node 22), so the npm scripts work unchanged on Node 22, 24
// and future versions where the flag is default-on or eventually removed.
import { spawnSync } from 'node:child_process';

const probe = spawnSync(process.execPath, ['--experimental-strip-types', '-e', ''], { stdio: 'ignore' });
const flags = probe.status === 0 ? ['--experimental-strip-types', '--no-warnings'] : ['--no-warnings'];
const res = spawnSync(process.execPath, [...flags, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(res.status ?? 1);
