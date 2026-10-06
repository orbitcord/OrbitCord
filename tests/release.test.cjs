const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

test('release versions are stable and installer names follow package.json automatically', async () => {
    const { stableVersion } = await import('../scripts/release-assets.mjs');
    const { version } = require('../package.json');
    const config = require('../electron-builder.cjs');
    assert.equal(stableVersion(version), version);
    assert.equal(config.buildVersion, version);
    assert.equal(config.artifactName, '${productName}-${version}-${os}-${arch}.${ext}');
    assert.equal(config.nsis.artifactName, '${productName}-${version}-windows-${arch}-Setup.${ext}');
    for (const invalid of ['0.1.5.1', '0.1.5-1', 'v0.1.7', '01.1.7', '0.1']) {
        assert.throws(() => stableVersion(invalid), /three-part stable/);
    }
});

test('publication rejects missing installers and mismatched update versions, sizes and hashes', async () => {
    const { verifyReleaseAssets } = await import('../scripts/release-assets.mjs');
    const directory = await mkdtemp(join(tmpdir(), 'orbitcord-release-'));
    const version = '0.1.7';
    const exe = `OrbitCord-${version}-windows-x64-Setup.exe`;
    const mac = `OrbitCord-${version}-mac-universal.dmg`;
    const sha512 = createHash('sha512').update('installer').digest('base64');
    const manifest = `version: ${version}\nfiles:\n  - url: ${exe}\n    sha512: ${sha512}\n    size: 9\npath: ${exe}\nsha512: ${sha512}\n`;
    try {
        await assert.rejects(verifyReleaseAssets(directory, version), /ENOENT/);
        for (const [file, content] of [[exe, 'installer'], [mac, 'dmg'], [`${exe}.blockmap`, 'map'], ['latest.yml', manifest], ['1.yml', manifest]]) {
            await writeFile(join(directory, file), content);
        }
        assert.deepEqual(await verifyReleaseAssets(directory, version), { version, mac, installer: exe });
        for (const broken of [manifest.replace('version: 0.1.7', 'version: 0.1.6'), manifest.replace('size: 9', 'size: 8'), manifest.replaceAll(sha512, 'incorrect')]) {
            await writeFile(join(directory, 'latest.yml'), broken);
            await assert.rejects(verifyReleaseAssets(directory, version), /does not match/);
        }
        await writeFile(join(directory, 'latest.yml'), manifest);
        await writeFile(join(directory, '1.yml'), manifest.replace('version: 0.1.7', 'version: 0.1.6'));
        await assert.rejects(verifyReleaseAssets(directory, version), /1.yml does not match/);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
