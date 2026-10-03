import { prepare } from './build.mjs';
import { build, Platform, Arch } from 'electron-builder';
import { join } from 'node:path';
import { root } from './build.mjs';

const requested = process.argv.slice(2);
if (requested.some(arg => !['--mac', '--win'].includes(arg))) {
    throw new Error('Usage: node scripts/installers.mjs [--mac] [--win]');
}
const mac = requested.length === 0 || requested.includes('--mac');
const win = requested.length === 0 || requested.includes('--win');
if (mac && process.platform !== 'darwin') throw new Error('Build the Mac installer on macOS.');
const config = join(root, 'electron-builder.cjs');

if (mac) {
    await prepare(true, { platform: 'darwin', arch: 'x64' });
    await prepare(true, { platform: 'darwin', arch: 'arm64' });
    await build({ targets: Platform.MAC.createTarget(['dmg'], Arch.universal), config, publish: 'never' });
}
if (win) {
    await prepare(true, { platform: 'win32', arch: 'x64' });
    await build({ targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), config, publish: 'never' });
}
