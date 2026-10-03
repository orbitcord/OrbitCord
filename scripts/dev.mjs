import { createRequire } from 'node:module';
import { prepare, run } from './build.mjs';
await prepare();
await run(createRequire(import.meta.url)('electron'), ['.'], { env: { ...process.env, LOWCORD_DEV: '1' } });
