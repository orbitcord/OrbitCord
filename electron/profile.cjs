const { cp, mkdir, readlink, access, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { homedir } = require('node:os');

function legacyProfile() {
    const cache = process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches')
        : process.platform === 'win32' ? process.env.LOCALAPPDATA
        : process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
    return cache && join(cache, 'dev.lowcord.app', 'cef');
}

async function exists(path) {
    try { await access(path); return true; } catch { return false; }
}

async function migrateProfile(destination, source = legacyProfile()) {
    const marker = join(destination, 'lowcord-migrated');
    if (await exists(marker)) return;
    if (source && await exists(join(source, 'Default', 'Local Storage'))) {
        // CEF uses Default/ under its cache root; Electron's default session
        // stores these same Chromium databases directly under sessionData.
        // Never copy a live LevelDB or overwrite a newer Electron profile.
        let lock;
        try { lock = await readlink(join(source, 'SingletonLock')); } catch {}
        const pid = Number(lock?.match(/-(\d+)$/)?.[1]);
        if (pid) {
            let running = true;
            try { process.kill(pid, 0); } catch (error) { running = error.code !== 'ESRCH'; }
            if (running) throw new Error('Quit the old CEF Lowcord app before migrating its profile.');
        }
        await mkdir(destination, { recursive: true });
        for (const name of ['Local Storage', 'IndexedDB', 'Session Storage', 'Cookies', 'Cookies-journal']) {
            const from = join(source, 'Default', name);
            const to = join(destination, name);
            if (await exists(from) && !await exists(to)) await cp(from, to, { recursive: true, force: false, errorOnExist: true });
        }
    }
    await mkdir(destination, { recursive: true });
    await writeFile(marker, 'Chromium profile migrated\n');
}

module.exports = { migrateProfile };
