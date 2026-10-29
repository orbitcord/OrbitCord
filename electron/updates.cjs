const { createHash } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const { mkdir, rename, rm, stat } = require('node:fs/promises');
const { join } = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { setTimeout: delay } = require('node:timers/promises');

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
function interrupted(error) {
    return error.retryable || /ECONNRESET|ERR_CONNECTION_|ERR_CONTENT_LENGTH_MISMATCH|ERR_HTTP2_PROTOCOL_ERROR|ERR_QUIC_PROTOCOL_ERROR|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|fetch failed|terminated|network|socket|abort|timed? ?out/i
        .test(`${error.code || ''} ${error.message || ''} ${error.cause?.code || ''}`);
}
async function downloadMacInstaller({ fetch, directory, asset, onProgress = () => {}, retryDelays = [500, 1500, 4000], idleTimeout = 30_000 }) {
    await mkdir(directory, { recursive: true });
    const path = join(directory, asset.name), temporary = `${path}.download`;
    // Only resume across calls when GitHub supplied a digest for this asset.
    // A partial file is never offered for installation.
    if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) await rm(temporary, { force: true });
    for (let attempt = 0; ; attempt++) {
        let size = (await stat(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; return { size: 0 }; })).size;
        if (size > asset.size) { await rm(temporary, { force: true }); size = 0; }
        let hash = createHash('sha256');
        // Rehash bytes actually flushed to disk, including after a failed pipeline.
        if (size) for await (const chunk of createReadStream(temporary)) hash.update(chunk);
        const control = new AbortController(), signal = control.signal;
        let timer, phase = 'connecting', sampledBytes = size, sampledAt = performance.now();
        const report = () => {
            const now = performance.now(), elapsed = (now - sampledAt) / 1000;
            onProgress(Math.floor(size / asset.size * 100), {
                transferred: size, total: asset.size,
                bytesPerSecond: phase === 'downloading' && elapsed > 0 ? Math.max(0, (size - sampledBytes) / elapsed) : 0,
                downloadPhase: phase,
            });
            sampledBytes = size; sampledAt = now;
        };
        // Keep the UI alive even when no bytes arrive. One IPC update per second
        // avoids publishing for every network chunk or percentage change.
        const ticker = setInterval(report, 1000);
        const watch = () => {
            clearTimeout(timer);
            timer = setTimeout(() => control.abort(Object.assign(new Error('Installer download stalled. Try again.'), { retryable: true })), idleTimeout);
        };
        try {
            report();
            if (size !== asset.size) {
                const url = (attempt || size) && Number.isSafeInteger(asset.id) && asset.id > 0
                    ? `https://api.github.com/repos/orbitcord/OrbitCord/releases/assets/${asset.id}?download=${Date.now()}`
                    : asset.browser_download_url;
                watch();
                const response = await fetch(url, { signal, cache: 'no-store', credentials: 'omit',
                    headers: { accept: 'application/octet-stream', ...(size ? { range: `bytes=${size}-` } : {}) } });
                if (!response.ok || !response.body) {
                    await response.body?.cancel().catch(() => {});
                    throw Object.assign(new Error(`Installer download failed (HTTP ${response.status}).`),
                        { retryable: [403, 408, 429, 500, 502, 503, 504].includes(response.status) });
                }
                if (response.status === 206) {
                    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
                    if (!range || Number(range[1]) !== size || Number(range[3]) !== asset.size
                        || Number(range[2]) < size || Number(range[2]) >= asset.size) {
                        await response.body.cancel().catch(() => {});
                        throw new Error('Installer download returned an invalid byte range. Try again.');
                    }
                } else {
                    // Some servers ignore Range. Truncate and hash the full response.
                    size = 0; hash = createHash('sha256');
                }
                phase = 'downloading';
                const progress = new Transform({ transform(chunk, _encoding, callback) {
                    watch();
                    size += chunk.length;
                    if (size > asset.size) return callback(new Error('Installer size does not match the release.'));
                    hash.update(chunk);
                    callback(null, chunk);
                } });
                await pipeline(Readable.fromWeb(response.body), progress,
                    createWriteStream(temporary, { flags: response.status === 206 ? 'a' : 'w', mode: 0o600 }), { signal });
            }
            if (size !== asset.size) throw Object.assign(new Error('Installer download is incomplete. Try again.'), { retryable: true });
            phase = 'verifying'; report();
            if (asset.digest && asset.digest !== `sha256:${hash.digest('hex')}`) throw new Error('Installer checksum does not match the release.');
            await rename(temporary, path);
            phase = 'complete'; report();
            return path;
        } catch (error) {
            if (control.signal.aborted) error = control.signal.reason;
            if (!interrupted(error)) { await rm(temporary, { force: true }); throw error; }
            if (attempt >= retryDelays.length) {
                throw new Error(`${error.message} Try again. The download will resume where it stopped.`, { cause: error });
            }
            phase = 'retrying'; report();
        } finally { clearTimeout(timer); clearInterval(ticker); }
        await delay(retryDelays[attempt]);
    }
}

function createUpdateController({ currentVersion, platform, packaged, getUpdater, getRelease, downloadInstaller, openInstaller, publish = () => {}, retryDelays = [500, 1500, 4000] }) {
    let state = { status: 'idle', currentVersion,
        installMode: platform === 'darwin' ? 'dmg' : platform === 'win32' && packaged ? 'automatic' : 'unavailable' };
    let pending, release, updater, installer, managedDownload = false;
    const snapshot = () => ({ ...state });
    const set = patch => { state = { ...state, error: null, ...patch }; publish(snapshot()); return snapshot(); };
    const fail = error => set({ status: state.status === 'installing' ? 'downloaded' : 'error',
        error: error.message || 'Update failed. Try again.' });
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
        updater.on('download-progress', info => set({ status: 'downloading', progress: Math.floor(info.percent),
            transferred: info.transferred, total: info.total, bytesPerSecond: info.bytesPerSecond, downloadPhase: 'downloading' }));
        updater.on('update-downloaded', info => set({ status: 'downloaded', version: info.version, progress: 100,
            transferred: state.total, bytesPerSecond: 0, downloadPhase: 'complete' }));
        updater.on('error', error => { if (!managedDownload) fail(error); });
        return updater;
    }
    async function check() {
        if (pending) return pending;
        if (['downloading', 'installing'].includes(state.status)) return snapshot();
        if (state.status === 'downloaded' && platform === 'win32') return snapshot();
        pending = (async () => {
            set({ status: 'checking', version: null, progress: null, transferred: null, total: null, bytesPerSecond: 0, downloadPhase: null });
            try {
                if (platform === 'win32' && packaged) {
                    const result = await initialize().checkForUpdates();
                    if (result?.downloadPromise) {
                        // electron-updater returns the automatic download as a
                        // separate promise. Observe it and retry network failures;
                        // otherwise its rejection escapes and the update stops.
                        managedDownload = true;
                        let task = result.downloadPromise;
                        try {
                            for (let attempt = 0; ; attempt++) {
                                try { await task; break; } catch (error) {
                                    if (!interrupted(error) || attempt >= retryDelays.length) throw error;
                                    set({ status: 'downloading' });
                                    await delay(retryDelays[attempt]);
                                    task = updater.downloadUpdate();
                                }
                            }
                        } finally { managedDownload = false; }
                    }
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
            set({ status: 'downloading', progress: 0, bytesPerSecond: 0, downloadPhase: 'connecting' });
            try {
                installer = await downloadInstaller(release, (percent, details = {}) => {
                    set({ progress: percent, ...details });
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
