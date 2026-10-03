import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const root = process.cwd();
const output = join(root, 'dist');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const installers = (await readdir(output)).filter(name => /-windows-x64-Setup\.exe$/i.test(name));
if (installers.length !== 1) throw new Error(`Expected one Windows x64 installer in dist, found ${installers.length}`);

const name = installers[0];
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
