const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { mkdtemp, readFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { isNewer, latestRelease, macAsset, downloadMacInstaller, createUpdateController } = require('../electron/updates.cjs');
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider');

const release = {
    tag_name: 'v0.1.6', html_url: 'https://github.com/orbitcord/OrbitCord/releases/tag/v0.1.6',
    assets: [{ name: 'OrbitCord-0.1.6-mac-universal.dmg', size: 4,
        browser_download_url: 'https://github.com/orbitcord/OrbitCord/releases/download/v0.1.6/OrbitCord-0.1.6-mac-universal.dmg' }],
};

test('stable updates compare with both legacy four-part version formats', () => {
    for (const current of ['0.1.5-1', '0.1.5.1', '0.1.5-2', '0.1.5']) assert.equal(isNewer('v0.1.6', current), true);
    assert.equal(isNewer('0.1.5.1', '0.1.5-1'), false);
    assert.equal(isNewer('0.1.5-2', '0.1.5.1'), true);
    assert.equal(isNewer('0.1.6', '0.1.6'), false);
    assert.equal(isNewer('0.1.6', '0.1.7'), false);
    assert.throws(() => isNewer('0.1.7-beta', '0.1.6'), /Unsupported/);
});

test('GitHub failures and unexpected releases produce actionable errors', async () => {
    await assert.rejects(latestRelease(async () => new Response('', { status: 403 })), /HTTP 403/);
    await assert.rejects(latestRelease(async () => Response.json({ ...release, prerelease: true })), /invalid stable release/);
    await assert.rejects(latestRelease(async () => Response.json({ ...release, html_url: 'https://github.com/other/repo' })), /invalid stable release/);
    assert.deepEqual(await latestRelease(async () => Response.json(release)), release);
    assert.equal(macAsset(release, 'arm64').name, release.assets[0].name);
    assert.throws(() => macAsset({ ...release, assets: [] }, 'x64'), /compatible Mac installer/);
});

test('Mac download verifies size and digest before making the installer available', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbitcord-download-'));
    try {
        const asset = { ...release.assets[0], digest: `sha256:${createHash('sha256').update('data').digest('hex')}` };
        const progress = [];
        const path = await downloadMacInstaller({ directory, asset, fetch: async () => new Response('data'), onProgress: value => progress.push(value) });
        assert.equal(await readFile(path, 'utf8'), 'data');
        assert.equal(progress.at(-1), 100);
        await assert.rejects(downloadMacInstaller({ directory, asset, fetch: async () => new Response('oops'), onProgress() {} }), /checksum/);
        await assert.rejects(downloadMacInstaller({ directory, asset, fetch: async () => new Response('d'), onProgress() {} }), /incomplete/);
        await assert.rejects(downloadMacInstaller({ directory, asset, fetch: async () => new Response('longer'), onProgress() {} }), /size/);
        assert.equal((await readdir(directory)).some(name => name.endsWith('.download')), false);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('manual Mac checks, download retry, and installation share one state', async () => {
    let checks = 0, downloads = 0, opened;
    const updates = createUpdateController({ currentVersion: '0.1.5-1', platform: 'darwin', packaged: true,
        getRelease: async () => { checks++; return release; },
        downloadInstaller: async (_release, progress) => {
            downloads++; progress(50);
            if (downloads === 1) throw new Error('Connection lost');
            return '/test/OrbitCord.dmg';
        }, openInstaller: async path => { opened = path; return ''; },
    });
    await Promise.all([updates.check(), updates.check()]);
    assert.equal(checks, 1);
    assert.equal(updates.snapshot().status, 'available');
    assert.equal((await updates.download()).error, 'Connection lost');
    assert.equal((await updates.download()).status, 'downloaded');
    await updates.install();
    assert.equal(opened, '/test/OrbitCord.dmg');
    assert.equal(updates.snapshot().status, 'downloaded');
});

test('Windows forces the stable channel for legacy versions and exposes download, retry, and install', async () => {
    const updater = new EventEmitter();
    let checks = 0, restarts = 0;
    updater.allowPrerelease = true;
    updater.checkForUpdates = async () => {
        checks++;
        updater.emit('update-available', { version: '0.1.6' });
    };
    updater.quitAndInstall = () => { restarts++; };
    const updates = createUpdateController({ currentVersion: '0.1.5-1', platform: 'win32', packaged: true, getUpdater: () => updater });
    await updates.check();
    assert.equal(updater.channel, 'latest');
    assert.equal(updater.allowPrerelease, false);
    assert.equal(updater.allowDowngrade, false);
    assert.equal(updater.autoDownload, true);
    await updates.check();
    assert.equal(checks, 1);
    updater.emit('download-progress', { percent: 42.5 });
    assert.equal(updates.snapshot().progress, 42);
    updater.emit('error', new Error('Download interrupted'));
    assert.equal(updates.snapshot().error, 'Download interrupted');
    await updates.check();
    assert.equal(checks, 2);
    updater.emit('update-downloaded', { version: '0.1.6' });
    await updates.install();
    assert.equal(restarts, 1);
});

test('the actual GitHub provider fails on the legacy channel and selects 0.1.6 after the fix', async () => {
    const updater = new EventEmitter();
    Object.assign(updater, { currentVersion: '0.1.5-1', allowPrerelease: true });
    const requests = [];
    const provider = new GitHubProvider({ provider: 'github', owner: 'orbitcord', repo: 'OrbitCord' }, updater, {
        platform: 'win32', executor: { async request(options) {
            requests.push(options.path);
            if (options.path.endsWith('.atom')) return '<feed><entry><title>0.1.6</title><link href="https://github.com/orbitcord/OrbitCord/releases/tag/v0.1.6"/><content>Update</content></entry></feed>';
            if (options.path.endsWith('/latest')) return JSON.stringify({ tag_name: 'v0.1.6' });
            if (options.path.endsWith('/latest.yml')) return 'version: 0.1.6\nfiles:\n  - url: OrbitCord-0.1.6-windows-x64-Setup.exe\n    sha512: test\n';
            throw new Error(`Unexpected request ${options.path}`);
        } },
    });
    await assert.rejects(provider.getLatestVersion(), error => error.code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS');
    const updates = createUpdateController({ currentVersion: '0.1.5-1', platform: 'win32', packaged: true, getUpdater: () => updater });
    updates.initialize();
    assert.equal((await provider.getLatestVersion()).version, '0.1.6');
    assert.equal(requests.at(-1), '/orbitcord/OrbitCord/releases/download/v0.1.6/latest.yml');
});

test('unmodified legacy Windows clients find the compatibility release and install the stable version', async () => {
    const updater = new EventEmitter();
    Object.assign(updater, { currentVersion: '0.1.5-1', allowPrerelease: true });
    const requests = [];
    const provider = new GitHubProvider({ provider: 'github', owner: 'orbitcord', repo: 'OrbitCord' }, updater, {
        platform: 'win32', executor: { async request(options) {
            requests.push(options.path);
            if (options.path.endsWith('.atom')) return '<feed><entry><title>Legacy bridge</title><link href="https://github.com/orbitcord/OrbitCord/releases/tag/v0.1.7-1"/><content>Stable update</content></entry><entry><title>0.1.7</title><link href="https://github.com/orbitcord/OrbitCord/releases/tag/v0.1.7"/><content>Update</content></entry></feed>';
            if (options.path.endsWith('/1.yml')) return 'version: 0.1.7\nfiles:\n  - url: OrbitCord-0.1.7-windows-x64-Setup.exe\n    sha512: test\n';
            throw new Error(`Unexpected request ${options.path}`);
        } },
    });
    const info = await provider.getLatestVersion();
    assert.equal(info.version, '0.1.7');
    assert.equal(info.tag, 'v0.1.7-1');
    assert.equal(requests.at(-1), '/orbitcord/OrbitCord/releases/download/v0.1.7-1/1.yml');
    assert.equal(provider.resolveFiles(info)[0].url.href, 'https://github.com/orbitcord/OrbitCord/releases/download/v0.1.7-1/OrbitCord-0.1.7-windows-x64-Setup.exe');
});
