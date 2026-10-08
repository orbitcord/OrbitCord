const { join } = require('node:path');
const { readFileSync, writeFileSync } = require('node:fs');

// Frees memory while OrbitCord's window is hidden or minimized. Caches are
// trimmed shortly after; with Sleep on, Discord is unloaded after a longer
// delay and reloaded when the window comes back.
const sleepDelays = [5, 15, 30, 60];
const defaults = { sleep: false, minutes: 15 };

function createBackgroundSaver({ window, userData, trusted, minute = 60_000 }) {
    const file = join(userData, 'background.json');
    let settings = read(), trimTimer, sleepTimer, asleep = null;
    const contents = window.webContents;

    function read() {
        try {
            const { sleep, minutes } = JSON.parse(readFileSync(file, 'utf8'));
            return { sleep: sleep === true, minutes: sleepDelays.includes(minutes) ? minutes : defaults.minutes };
        } catch { return { ...defaults }; }
    }
    const hidden = () => !window.isDestroyed() && (!window.isVisible() || window.isMinimized());

    async function trim() {
        if (window.isDestroyed() || contents.isDestroyed()) return;
        // Blink's image and resource caches live in the renderer; GC and a
        // critical pressure signal release V8 heap and Chromium caches.
        contents.send('lowcord:trim-memory');
        const attached = !contents.debugger.isAttached();
        try {
            if (attached) contents.debugger.attach('1.3');
            await contents.debugger.sendCommand('HeapProfiler.collectGarbage');
            await contents.debugger.sendCommand('Memory.simulatePressureNotification', { level: 'critical' });
        } catch (error) { console.error('[lowcord] Memory trim:', error.message); }
        finally { if (attached && contents.debugger.isAttached()) contents.debugger.detach(); }
    }

    // Calls, uploads and playing media keep Discord awake. The page answers
    // through a hook installed before Discord's scripts run.
    async function busy() {
        if (contents.isCurrentlyAudible()) return true;
        const answer = contents.executeJavaScript('window.__lowcordBusy?.() === true');
        const timeout = new Promise(resolve => setTimeout(resolve, 2000, false));
        return Promise.race([answer, timeout]).catch(() => false);
    }

    async function sleep() {
        if (!settings.sleep || asleep || !hidden()) return;
        const url = contents.getURL();
        if (!trusted(url)) return;
        if (await busy()) { sleepTimer = setTimeout(sleep, minute); return; }
        if (!hidden() || asleep) return;
        asleep = url;
        // about:blank stays in Discord's renderer process; a data: page is
        // cross-site, so Chromium exits that process and frees all of it.
        await contents.loadURL('data:text/html,<body style="background:rgb(49,51,56)">').catch(() => {});
        contents.navigationHistory.clear();
        void trim();
    }

    function wake() {
        clearTimeout(trimTimer); clearTimeout(sleepTimer);
        if (!asleep) return;
        const url = asleep;
        asleep = null;
        contents.loadURL(url).catch(error => console.error('[lowcord] Wake:', error.message));
    }

    function schedule() {
        clearTimeout(trimTimer); clearTimeout(sleepTimer);
        if (asleep) return;
        trimTimer = setTimeout(() => { if (hidden()) void trim(); }, minute / 2);
        if (settings.sleep) sleepTimer = setTimeout(() => void sleep(), settings.minutes * minute);
    }

    // Closing to the tray, Cmd+H and minimizing all emit hide or minimize.
    for (const event of ['hide', 'minimize']) window.on(event, schedule);
    for (const event of ['show', 'restore', 'focus']) window.on(event, wake);

    return {
        get: () => ({ ...settings }),
        set(next) {
            if (typeof next?.sleep !== 'boolean' || !sleepDelays.includes(next.minutes)) throw new Error('Invalid background settings');
            settings = { sleep: next.sleep, minutes: next.minutes };
            try { writeFileSync(file, JSON.stringify(settings)); } catch (error) { console.error('[lowcord]', error.message); }
            if (hidden()) schedule();
            return { ...settings };
        },
    };
}

module.exports = { createBackgroundSaver };
