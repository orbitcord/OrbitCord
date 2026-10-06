import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { stableVersion } from './release-assets.mjs';

const root = process.cwd();
const output = join(root, 'dist');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
stableVersion(version);
const name = `OrbitCord-${version}-windows-x64-Setup.exe`;
const path = join(output, name);
const data = await readFile(path);
const sha512 = createHash('sha512').update(data).digest('base64');
const { size } = await stat(path);
const yamlString = value => JSON.stringify(value);
const lines = [
    `version: ${yamlString(version)}`,
    'files:',
    `  - url: ${yamlString(basename(path))}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${yamlString(basename(path))}`,
    `sha512: ${sha512}`,
    `releaseDate: ${yamlString(new Date().toISOString())}`,
    '',
];
await writeFile(join(output, 'latest.yml'), lines.join('\n'));
// 0.1.5-1 clients look for the numeric prerelease channel. Their compatibility
// release advertises the stable installer version so installing it exits that channel.
await writeFile(join(output, '1.yml'), lines.join('\n'));
