const { readFileSync } = require('node:fs');
const { writeFile } = require('node:fs/promises');

// Leave No Trace. Choices live in the main process because they must still apply
// while the page is closing. OrbitCord's settings share Discord's localStorage, so
// signing out removes everything else there and keeps keys named lowcord.
const removeSignIn = `(() => {
    const storage = window.__lowcordStorage;
    if (!storage) return false;
    for (const key of Object.keys(storage)) if (!/^lowcord/i.test(key)) storage.removeItem(key);
    return true;
})()`;
const cached = { storages: ['cachestorage', 'shadercache'] };
const signedIn = { storages: ['cookies', 'indexdb', 'serviceworkers', 'filesystem', 'websql'] };

function createTraces({ file, sessions, windows, limit = 8000 }) {
    let settings = { clearOnQuit: false, signOut: false };
    try {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        settings = { clearOnQuit: saved.clearOnQuit === true, signOut: saved.signOut === true };
    } catch {}
    const everySession = async work => { await Promise.all(sessions().map(work)); };
    async function clearCache() {
        await everySession(ses => Promise.all([ses.clearCache(), ses.clearCodeCaches({}), ses.clearStorageData(cached)]));
    }
    async function clearSignIn() {
        const open = windows().filter(({ window }) => !window.isDestroyed());
        const kept = new Set();
        await Promise.all(open.map(async ({ window, session }) => {
            if (await window.webContents.executeJavaScript(removeSignIn).catch(() => false)) kept.add(session);
        }));
        await everySession(ses => kept.has(ses) ? ses.clearStorageData(signedIn) : ses.clearStorageData());
        await everySession(ses => ses.flushStorageData());
        // Unload handlers could write the sign-in back, so these windows skip them.
        for (const { window } of open) if (!window.isDestroyed()) window.destroy();
    }
    return {
        get settings() { return { ...settings }; },
        async status() {
            const sizes = await Promise.all(sessions().map(ses => ses.getCacheSize().catch(() => 0)));
            return { ...settings, cacheBytes: sizes.reduce((sum, size) => sum + size, 0) };
        },
        async set(next) {
            settings = { clearOnQuit: next.clearOnQuit === true, signOut: next.clearOnQuit === true && next.signOut === true };
            await writeFile(file, JSON.stringify(settings));
            return { ...settings };
        },
        clearCache,
        // Quit must not hang on a stuck session.
        async onQuit({ keepSignIn = false } = {}) {
            if (!settings.clearOnQuit) return;
            let timer;
            const work = Promise.all([clearCache(), settings.signOut && !keepSignIn ? clearSignIn() : null]);
            await Promise.race([work, new Promise(resolve => { timer = setTimeout(resolve, limit); })])
                .catch(error => console.error('[lowcord]', error.message));
            clearTimeout(timer);
        },
    };
}
module.exports = { createTraces };
