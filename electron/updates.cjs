const { createHash } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { mkdir, rename, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// Older installers displayed 0.1.5.1 but stored 0.1.5-1 in package.json.
// Treat either form as the same fourth numeric revision.
function versionParts(version) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[.-](\d+))?$/.exec(version || '');
    if (!match) throw new Error(`Unsupported app version: ${version}`);
    return match.slice(1).map(part => Number(part || 0));
}
function isNewer(available, current) {
    const next = versionParts(available), previous = versionParts(current);
    for (let i = 0; i < next.length; i++) {
        if (next[i] !== previous[i]) return next[i] > previous[i];
    }
    return false;
}

const repository = 'https://github.com/orbitcord/OrbitCord';
async function latestRelease(fetch) {
    const response = await fetch('https://api.github.com/repos/orbitcord/OrbitCord/releases/latest', {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'OrbitCord' },
        signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub update check failed (HTTP ${response.status}). Try again later.`);
    const release = await response.json();
    versionParts(release.tag_name);
    if (release.draft || release.prerelease || release.html_url !== `${repository}/releases/tag/${release.tag_name}`)
        throw new Error('GitHub returned an invalid stable release.');
    return release;
}
function macAsset(release, arch) {
    const assets = release.assets || [];
    const asset = assets.find(asset => asset.name === `OrbitCord-${release.tag_name.replace(/^v/, '')}-mac-universal.dmg`)
        || assets.find(asset => asset.name === `OrbitCord-${release.tag_name.replace(/^v/, '')}-mac-${arch}.dmg`);
    if (!asset || asset.browser_download_url !== `${repository}/releases/download/${release.tag_name}/${asset.name}`
        || !Number.isSafeInteger(asset.size) || asset.size <= 0)
        throw new Error('This release does not include a compatible Mac installer.');
    return asset;
}
async function downloadMacInstaller({ fetch, directory, asset, onProgress }) {
    await mkdir(directory, { recursive: true });
    const path = join(directory, asset.name), temporary = `${path}.download`;
    try {
        const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(30 * 60_000) });
        if (!response.ok || !response.body) throw new Error(`Installer download failed (HTTP ${response.status}).`);
        let size = 0;
        const hash = createHash('sha256');
        const progress = new Transform({ transform(chunk, _encoding, callback) {
            size += chunk.length;
            if (size > asset.size) return callback(new Error('Installer size does not match the release.'));
            hash.update(chunk);
            onProgress(Math.floor(size / asset.size * 100));
            callback(null, chunk);
        } });
        await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(temporary, { mode: 0o600 }));
        if (size !== asset.size) throw new Error('Installer download is incomplete. Please retry.');
        const digest = hash.digest('hex');
        if (asset.digest && asset.digest !== `sha256:${digest}`) throw new Error('Installer checksum does not match the release.');
        await rename(temporary, path);
        return path;
    } catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}

function createUpdateController({ currentVersion, platform, packaged, getUpdater, getRelease, downloadInstaller, openInstaller, publish = () => {} }) {
    let state = { status: 'idle', currentVersion,
        installMode: platform === 'darwin' ? 'dmg' : platform === 'win32' && packaged ? 'automatic' : 'unavailable' };
    let pending, release, updater, installer;
    const snapshot = () => ({ ...state });
    const set = patch => { state = { ...state, error: null, ...patch }; publish(snapshot()); return snapshot(); };
    const fail = error => set({ status: state.status === 'installing' ? 'downloaded' : 'error',
        error: error.message || 'Update failed. Please try again.' });
    function initialize() {
        if (updater) return updater;
        updater = getUpdater();
        // Numeric legacy revisions must never select a prerelease channel.
        updater.channel = 'latest';
        updater.allowPrerelease = false;
        updater.allowDowngrade = false;
        updater.autoDownload = true;
        updater.autoInstallOnAppQuit = true;
        updater.on('checking-for-update', () => set({ status: 'checking', progress: null }));
        updater.on('update-not-available', () => set({ status: 'up-to-date', version: null }));
        updater.on('update-available', info => set({ status: 'downloading', version: info.version, progress: 0 }));
        updater.on('download-progress', info => set({ status: 'downloading', progress: Math.floor(info.percent) }));
        updater.on('update-downloaded', info => set({ status: 'downloaded', version: info.version, progress: 100 }));
        updater.on('error', fail);
        return updater;
    }
    async function check() {
        if (pending) return pending;
        if (['downloading', 'installing'].includes(state.status)) return snapshot();
        if (state.status === 'downloaded' && platform === 'win32') return snapshot();
        pending = (async () => {
            set({ status: 'checking', version: null, progress: null });
            try {
                if (platform === 'win32' && packaged) {
                    await initialize().checkForUpdates();
                } else {
                    release = await getRelease();
                    installer = null;
                    set({ status: isNewer(release.tag_name, currentVersion) ? 'available' : 'up-to-date',
                        version: release.tag_name.replace(/^v/, '') });
                }
            } catch (error) { fail(error); }
            return snapshot();
        })();
        try { return await pending; } finally { pending = null; }
    }
    async function download() {
        if (pending) return pending;
        if (platform !== 'darwin') return snapshot();
        if (!release || !['available', 'error'].includes(state.status)) return snapshot();
        pending = (async () => {
            set({ status: 'downloading', progress: 0 });
            try {
                installer = await downloadInstaller(release, percent => {
                    if (percent !== state.progress) set({ progress: percent });
                });
                set({ status: 'downloaded', progress: 100 });
            } catch (error) { fail(error); }
            return snapshot();
        })();
        try { return await pending; } finally { pending = null; }
    }
    async function install() {
        if (pending || state.status !== 'downloaded') return snapshot();
        set({ status: 'installing' });
        try {
            if (platform === 'win32' && updater) updater.quitAndInstall();
            else if (platform === 'darwin' && installer) {
                const error = await openInstaller(installer);
                if (error) throw new Error(error);
                set({ status: 'downloaded' });
            } else throw new Error('No downloaded installer is available.');
        } catch (error) { set({ status: 'downloaded', error: error.message }); }
        return snapshot();
    }
    return { snapshot, check, download, install, initialize };
}

module.exports = { versionParts, isNewer, latestRelease, macAsset, downloadMacInstaller, createUpdateController };
