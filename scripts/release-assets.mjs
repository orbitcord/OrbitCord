import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { parseUpdateInfo } = require('electron-updater/out/providers/Provider');

export function stableVersion(version) {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
        throw new Error(`Release version must be a three-part stable version: ${version}`);
    }
    return version;
}

export async function verifyReleaseAssets(directory, version) {
    stableVersion(version);
    const installer = `OrbitCord-${version}-windows-x64-Setup.exe`;
    const mac = `OrbitCord-${version}-mac-universal.dmg`;
    for (const file of [mac, installer, `${installer}.blockmap`]) {
        if (!(await stat(join(directory, file))).size) throw new Error(`Empty release asset: ${file}`);
    }
    const hash = createHash('sha512');
    for await (const chunk of createReadStream(join(directory, installer))) hash.update(chunk);
    const checksum = hash.digest('base64');
    const size = (await stat(join(directory, installer))).size;
    for (const channel of ['latest.yml', '1.yml']) {
        const info = parseUpdateInfo(await readFile(join(directory, channel), 'utf8'), channel, 'local release');
        const file = info.files?.[0];
        if (info.version !== version || info.path !== installer || info.files?.length !== 1 || file?.url !== installer
            || file.size !== size || info.sha512 !== checksum || file.sha512 !== checksum) {
            throw new Error(`${channel} does not match the ${version} Windows installer and checksum`);
        }
    }
    return { version, mac, installer };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const { version } = JSON.parse(await readFile('package.json', 'utf8'));
    console.log(await verifyReleaseAssets(resolve(process.argv[2] || 'dist'), version));
}
