import { chromium, _electron as electron } from '@playwright/test';
import { readFile, writeFile, mkdir, mkdtemp, rm, cp, symlink, access } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { tmpdir, platform, arch, cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const options = Object.fromEntries(process.argv.slice(2).filter(arg => arg !== '--').map(arg => {
    const index = arg.indexOf('='); return index < 0 ? [arg.replace(/^--/, ''), true] : [arg.slice(2, index), arg.slice(index + 1)];
}));
const scenario = options.scenario || 'all', iterations = Number(options.iterations || 3);
const rows = String(options.rows || '50,200,500').split(',').map(Number);
const clipMiB = Number(options['clip-mib'] ?? 64), idleSeconds = Number(options['idle-seconds'] ?? 10);
if (!['all', 'chat', 'media', 'startup', 'idle', 'visual', 'playback', 'dom', 'modules'].includes(scenario) || !Number.isInteger(iterations) || iterations < 1 || iterations > 30
    || rows.some(value => !Number.isInteger(value) || value < 1 || value > 2000)
    || !Number.isInteger(clipMiB) || clipMiB < 1 || clipMiB > 80
    || !Number.isInteger(idleSeconds) || idleSeconds < 1 || idleSeconds > 60) throw new Error('Invalid benchmark options');
const baseline = options.baseline && resolve(String(options.baseline));
const variants = [...(baseline ? [{ name: 'baseline', directory: baseline }] : []), { name: 'current', directory: root }];
const output = resolve(String(options.output || join(tmpdir(), 'lowcord-performance.json')));
const report = { environment: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, ramGiB: totalmem() / 1024 ** 3,
    node: process.version, recordedAt: new Date().toISOString() }, scenario, iterations, rows, variants, results: [] };
const hash = value => createHash('sha256').update(value).digest('hex');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
const wanted = name => scenario === 'all' || scenario === name;
let server, browser, url;

async function fixtureServer() {
    const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    let errors = '';
    server = spawn(process.execPath, ['tests/fixture-server.mjs'], { cwd: root, env: { ...process.env, LOWCORD_FIXTURE_PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'] });
    server.stderr.on('data', data => { errors = (errors + data).slice(-4000); });
    url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
        if (server.exitCode !== null) throw new Error(`Fixture server exited: ${errors}`);
        try { if ((await fetch(url)).ok) return; } catch {}
        await pause(50);
    }
    throw new Error(`Fixture server did not become ready: ${errors}`);
}
async function chatPage(variant, options = {}) {
    const page = await browser.newPage({ viewport: { width: options.width || 1000, height: 800 } });
    let code = await readFile(join(variant.directory, 'src-tauri/injection/chat-appearance.js'), 'utf8');
    if (!code.includes('    function refresh() {')) throw new Error('Chat benchmark instrumentation needs updating');
    code = code.replace('    function refresh() {', '    function refresh() { const start = performance.now(); try { return measuredRefresh(); } finally { window.__perf.push(performance.now() - start); } }\n    function measuredRefresh() {');
    await page.addInitScript(() => { window.__perf = []; });
    await page.route('**/appearance.js', route => route.fulfill({ contentType: 'text/javascript', body: code }));
    const css = await readFile(join(variant.directory, 'src-tauri/injection/chat-appearance.css'), 'utf8');
    await page.route('**/appearance.css', route => route.fulfill({ contentType: 'text/css', body: css }));
    await page.goto(`${url}/?theme=${options.theme || 'dark'}&options=${encodeURIComponent(JSON.stringify({ style: options.style || 'bubbles', timestamps: true }))}`);
    await page.waitForFunction(() => window.__lowcordChatAppearance && document.querySelector('[data-lowcord-bubble]'));
    await page.evaluate(async () => { await document.fonts.ready; for (let i = 0; i < 6; i++) await new Promise(requestAnimationFrame); });
    return page;
}
async function chatBenchmarks() {
    browser ??= await chromium.launch({ headless: true }); report.environment.chromium = browser.version();
    for (const count of rows) for (let repeat = 0; repeat < iterations; repeat++) {
        for (const variant of repeat % 2 ? variants.slice().reverse() : variants) {
            const page = await chatPage(variant);
            try {
                await page.evaluate(async n => {
                    document.querySelector('#timeline').replaceChildren();
                    for (const key of Object.keys(fixture.messages)) delete fixture.messages[key];
                    for (let i = 0; i < n; i++) fixture.add(1000 + i, i % 2 ? 'self' : 'other', `<div class="messageContent_test">Message ${i}</div>`);
                    for (let i = 0; i < 6; i++) await new Promise(requestAnimationFrame);
                    for (let i = 0; i < 5; i++) { fixture.emit('MessageStore'); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); }
                    window.__perf = [];
                }, count);
                const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
                const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
                const before = await metrics();
                const data = await page.evaluate(async n => {
                    for (let i = 0; i < 30; i++) {
                        fixture.messages[1000 + Math.floor(n / 2)].content = `Message updated ${i}`;
                        document.getElementById(`chat-messages-100-${1000 + Math.floor(n / 2)}`).querySelector('.messageContent_test').textContent = `Message updated ${i}`;
                        fixture.emit('MessageStore'); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
                    }
                    const durations = [...window.__perf]; window.__perf = [];
                    for (let i = 0; i < 30; i++) await new Promise(requestAnimationFrame);
                    return { durations, idleScans: window.__perf.length, dom: document.querySelector('#timeline').outerHTML };
                }, count);
                const after = await metrics(), times = data.durations.slice().sort((a, b) => a - b);
                const result = { scenario: 'chat', variant: variant.name, rows: count, repeat, updates: 30,
                    refreshes: times.length, medianMs: median(times), p95Ms: times[Math.min(times.length - 1, Math.floor(times.length * .95))],
                    totalRefreshMs: times.reduce((sum, time) => sum + time, 0), idleScans: data.idleScans,
                    scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000, layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
                    heapMiB: after.JSHeapUsedSize / 1024 ** 2, domHash: hash(data.dom) };
                report.results.push(result); console.log(JSON.stringify(result));
                const pair = report.results.find(other => other.scenario === 'chat' && other.rows === count && other.repeat === repeat && other.variant !== variant.name);
                if (!times.length || data.idleScans || (pair && pair.domHash !== result.domHash)) throw new Error('Chat benchmark behavior differs');
            } finally { await page.close(); }
        }
    }
}
async function visualChecks() {
    browser ??= await chromium.launch({ headless: true });
    for (const style of ['bubbles', 'avatars']) for (const theme of ['dark', 'light']) for (const width of [520, 1000]) {
        const checks = [];
        for (const variant of variants) {
            const page = await chatPage(variant, { style, theme, width });
            try {
                const data = await page.evaluate(async () => {
                    fixture.messages[2].timestamp = '2026-10-03T06:25:00Z'; fixture.emit('MessageStore');
                    for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
                    const row = fixture.add(100, 'self', '<div class="messageContent_test">New message</div>');
                    const firstPaint = await new Promise(resolve => requestAnimationFrame(() => resolve(row.firstElementChild.hasAttribute('data-lowcord-bubble'))));
                    for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
                    return { firstPaint, dom: document.querySelector('#timeline').outerHTML };
                });
                const screenshot = await page.screenshot();
                const screenshotPath = `${output}.${style}-${theme}-${width}-${variant.name}.png`;
                await writeFile(screenshotPath, screenshot);
                checks.push({ variant: variant.name, domHash: hash(data.dom), screenshotHash: hash(screenshot), screenshotPath, firstPaint: data.firstPaint });
            } finally { await page.close(); }
        }
        const result = { scenario: 'visual', style, theme, width, checks, identical: checks.every(check => check.domHash === checks[0].domHash && check.screenshotHash === checks[0].screenshotHash),
            firstPaintStyled: checks.every(check => check.firstPaint) };
        report.results.push(result); console.log(JSON.stringify(result));
        if (!result.identical || !result.firstPaintStyled) throw new Error('Visual or first-paint regression');
    }
}
// A Discord-like page: every injection script from the variant, stores in a
// webpack cache, and a busy UI around a timeline (hover classes, typing and
// presence text, composer edits, new messages). Lowcord's DOM observers see
// the same mutations Discord's app shell produces while someone is chatting.
async function domPage(variant) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const files = { '/appearance.js': 'src-tauri/injection/chat-appearance.js', '/appearance.css': 'src-tauri/injection/chat-appearance.css',
        '/social-links.js': 'electron/social-links.cjs', '/music-links.js': 'electron/music-links.cjs' };
    for (const file of ['discord.js', 'extensions.js', 'gif.js', 'music-embeds.js', 'social-embeds.js', 'settings.js', 'lowcord-ui.css'])
        files[`/injection/${file}`] = `src-tauri/injection/${file}`;
    for (const [path, file] of Object.entries(files)) {
        const body = await readFile(join(variant.directory, file));
        await page.route(`${url}${path}`, route => route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript', body }));
    }
    await page.route(/^https:\/\/(open\.spotify\.com|embed\.music\.apple\.com)\//, route => route.fulfill({ contentType: 'text/html', body: '<p>player</p>' }));
    await page.addInitScript(() => {
        const messages = {}, listeners = new Map();
        const store = (name, methods) => {
            const Store = class {}; Object.defineProperty(Store, 'displayName', { value: name });
            const value = Object.assign(new Store(), methods);
            listeners.set(name, new Set());
            value.addChangeListener = fn => listeners.get(name).add(fn);
            value.removeChangeListener = fn => listeners.get(name).delete(fn);
            return value;
        };
        const stores = [store('SelectedChannelStore', { getChannelId: () => '100' }), store('ChannelStore', { getChannel: () => ({ id: '100', type: 1 }) }),
            store('UserStore', { getCurrentUser: () => ({ id: 'self' }), getUser: id => ({ id, getAvatarURL: () => '' }) }),
            store('MessageStore', { getMessage: (_, id) => messages[id] })];
        const cache = {};
        // Discord's cache holds thousands of modules; lookups traverse them.
        for (let i = 0; i < 4000; i++) cache[i] = { exports: { a: { value: i }, b: [i], c: `module ${i}` } };
        stores.forEach((value, i) => { cache[`store${i}`] = { exports: { default: value } }; });
        const chunks = []; chunks.push = entry => { entry[2]({ c: cache }); return 1; };
        window.webpackChunkdiscord_app = chunks;
        window.bench = { messages, emit: name => { for (const fn of listeners.get(name)) fn(); } };
    });
    await page.goto(`${url}/extensions`);
    await page.waitForFunction(() => window.fixtureReady && window.Lowcord.store('MessageStore'));
    return page;
}
async function domBenchmarks() {
    browser ??= await chromium.launch({ headless: true }); report.environment.chromium = browser.version();
    for (let repeat = 0; repeat < iterations; repeat++) for (const variant of repeat % 2 ? variants.slice().reverse() : variants) {
        const page = await domPage(variant);
        try {
            await page.evaluate(async () => {
                const frame = () => new Promise(requestAnimationFrame);
                const main = document.querySelector('main');
                const timeline = document.createElement('ol'); timeline.id = 'timeline';
                const members = document.createElement('aside'); members.className = 'members_test';
                const typing = document.createElement('div'); typing.className = 'typing_test'; typing.textContent = 'Alex is typing';
                main.prepend(timeline); main.append(members, typing);
                for (let i = 0; i < 150; i++) members.insertAdjacentHTML('beforeend', `<div class="member_test"><span class="name_test">Member ${i}</span><span class="activity_test">Playing for ${i} minutes</span></div>`);
                const editor = document.createElement('div'); editor.contentEditable = 'true'; editor.setAttribute('role', 'textbox');
                editor.innerHTML = '<p><span>https://open.spotify.com/track/0Lr4kGOYn9l83EjuK6cZFQ </span></p>';
                document.querySelector('.channelTextArea_test').append(editor);
                editor.dispatchEvent(new Event('input', { bubbles: true }));
                window.bench.add = (id, author, content) => {
                    bench.messages[id] = { id: String(id), channel_id: '100', author: { id: author }, type: 0, content, timestamp: '2026-10-03T05:00:00Z' };
                    const row = document.createElement('li'); row.id = `chat-messages-100-${id}`;
                    row.innerHTML = `<div class="message_test" data-list-item-id="chat-messages___100-${id}"><div class="contents_test"><h3 class="header_test">${author} <time>10:30 AM</time></h3><div id="message-content-${id}" class="messageContent_test">${content}</div></div></div>`;
                    timeline.append(row); bench.emit('MessageStore');
                };
                for (let i = 0; i < 100; i++) bench.add(1000 + i, i % 2 ? 'self' : 'other',
                    i % 10 === 0 ? `listen https://open.spotify.com/track/0Lr4kGOYn9l83EjuK6cZFQ ${i}` : `Message ${i}`);
                for (let i = 0; i < 20; i++) await frame();
            });
            const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
            const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
            const before = await metrics();
            const data = await page.evaluate(async () => {
                const frame = () => new Promise(requestAnimationFrame);
                const members = [...document.querySelectorAll('.member_test')], activities = [...document.querySelectorAll('.activity_test')];
                const typing = document.querySelector('.typing_test').firstChild;
                const editorText = document.querySelector('[role="textbox"] span').firstChild;
                const start = performance.now();
                for (let i = 0; i < 600; i++) {
                    members[(i + 149) % 150].classList.remove('hovered_test'); members[i % 150].classList.add('hovered_test');
                    typing.data = `Alex is typing${'.'.repeat(i % 4)}`;
                    if (i % 4 === 0) activities[i % 150].firstChild.data = `Playing for ${i} minutes`;
                    if (i % 15 === 0) document.querySelector(`#chat-messages-100-${1000 + (i % 100)} .message_test`).classList.toggle('selected_test');
                    if (i % 10 === 0) { editorText.data += 'a'; editorText.parentElement.dispatchEvent(new Event('input', { bubbles: true })); }
                    if (i % 30 === 0) bench.add(2000 + i, i % 60 ? 'self' : 'other', i % 90 === 0 ? `new https://open.spotify.com/track/0Lr4kGOYn9l83EjuK6cZFQ ${i}` : `New message ${i}`);
                    await frame();
                }
                const elapsed = performance.now() - start;
                for (let i = 0; i < 10; i++) await frame();
                document.querySelectorAll('.hovered_test, .selected_test').forEach(node => node.classList.remove('hovered_test', 'selected_test'));
                return { elapsed, dom: document.querySelector('main').outerHTML, features: {
                    bubbles: document.querySelectorAll('[data-lowcord-bubble]').length,
                    messagePlayers: document.querySelectorAll('.lowcord-music-embeds .lowcord-music-player').length,
                    draftPlayers: document.querySelectorAll('.lowcord-music-draft .lowcord-music-player').length,
                    voiceButtons: document.querySelectorAll('.lowcord-voice-button').length } };
            });
            const after = await metrics();
            const result = { scenario: 'dom', variant: variant.name, repeat, frames: 600,
                scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000, taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
                layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000, recalcStyleMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000,
                heapMiB: after.JSHeapUsedSize / 1024 ** 2, wallMs: data.elapsed, features: data.features, domHash: hash(data.dom) };
            report.results.push(result); console.log(JSON.stringify(result));
            const pair = report.results.find(other => other.scenario === 'dom' && other.repeat === repeat && other.variant !== variant.name);
            if (pair && pair.domHash !== result.domHash) throw new Error('DOM benchmark output differs between variants');
        } finally { await page.close(); }
    }
}
// A store that never appears (renamed by Discord) keeps lookups polling. The
// cache holds Discord-scale exports; a late module must still resolve.
async function moduleBenchmarks() {
    browser ??= await chromium.launch({ headless: true });
    for (let repeat = 0; repeat < iterations; repeat++) for (const variant of repeat % 2 ? variants.slice().reverse() : variants) {
        const page = await browser.newPage();
        try {
            await page.goto(`${url}/electron-child`);
            await page.evaluate(() => {
                const cache = {};
                for (let i = 0; i < 20000; i++) cache[i] = { exports: { default: { id: i }, helper() {}, value: `m${i}`, list: [i] } };
                window.benchCache = cache;
                const chunks = []; chunks.push = entry => { entry[2]({ c: cache }); return 1; };
                window.webpackChunkdiscord_app = chunks;
                window.__lowcordStorage = localStorage;
            });
            await page.addScriptTag({ content: await readFile(join(variant.directory, 'src-tauri/injection/discord.js'), 'utf8') });
            const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
            const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
            const before = await metrics();
            const late = await page.evaluate(async () => {
                Lowcord.waitForStore('RenamedStore', () => {});
                await new Promise(resolve => setTimeout(resolve, 8000));
                // Discord lazily loads a module mid-session; its store must still be found.
                const Late = class {}; Object.defineProperty(Late, 'displayName', { value: 'LateStore' });
                let found;
                const waited = new Promise(resolve => Lowcord.waitForStore('LateStore', value => { found = performance.now(); resolve(value); }));
                await new Promise(resolve => setTimeout(resolve, 2000));
                const added = performance.now(); benchCache.late = { exports: { default: new Late() } };
                await waited;
                await new Promise(resolve => setTimeout(resolve, Math.max(0, 2000 - (performance.now() - added))));
                return found - added;
            });
            const after = await metrics();
            const result = { scenario: 'modules', variant: variant.name, repeat, seconds: 12, modules: 20000,
                scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000, lateStoreFoundMs: late };
            report.results.push(result); console.log(JSON.stringify(result));
        } finally { await page.close(); }
    }
}
function mediaChild(directory) {
    return `
        const {createRedditFixture} = require(${JSON.stringify(join(root, 'tests/fixtures/reddit-playback.cjs'))});
        const {createSocialPosts} = require(${JSON.stringify(join(directory, 'electron/social-posts.cjs'))});
        const {performance} = require('node:perf_hooks');
        (async () => {
            const fixture=createRedditFixture(${JSON.stringify(root)},{clipMiB:${clipMiB}}), posts=createSocialPosts(fixture.fetchPage);
            for(let i=0;i<3;i++)global.gc(); const start=process.memoryUsage(), peak=process.resourceUsage().maxRSS, cpu=process.cpuUsage(), t=performance.now();
            const readiness=[]; for(const id of ['abc1','abc2','abc3']){
                const post=await posts.get('https://www.reddit.com/comments/'+id+'/'); const began=performance.now();
                const response=await posts.serve(new Request(post.media[0].src,{headers:{range:'bytes=0-0'}}));
                if(response.status!==206 || (await response.arrayBuffer()).byteLength!==1)throw new Error('Playback range failed'); readiness.push(performance.now()-began);
            }
            const elapsedMs=performance.now()-t, used=process.cpuUsage(cpu); await new Promise(setImmediate); for(let i=0;i<3;i++)global.gc();
            const end=process.memoryUsage(); const result={elapsedMs,cpuMs:(used.user+used.system)/1000,firstByteMs:readiness,
                retainedArrayBuffersMiB:(end.arrayBuffers-start.arrayBuffers)/1024**2,peakRssDeltaMiB:(process.resourceUsage().maxRSS-peak)/1024,
                endingRssDeltaMiB:(end.rss-start.rss)/1024**2}; await posts.close?.(); console.log(JSON.stringify(result));
        })().catch(error=>{console.error(error);process.exitCode=1});`;
}
function mediaBenchmarks() {
    for (let repeat = 0; repeat < iterations; repeat++) for (const variant of repeat % 2 ? variants.slice().reverse() : variants) {
        const data = JSON.parse(execFileSync(process.execPath, ['--expose-gc', '-e', mediaChild(variant.directory)], { encoding: 'utf8', cwd: root }));
        const result = { scenario: 'media', variant: variant.name, repeat, clips: 3, clipMiB, ...data };
        report.results.push(result); console.log(JSON.stringify(result));
    }
}
async function prepareElectron(variant) {
    if (variant.directory !== root) {
        await mkdir(join(variant.directory, '.lowcord'), { recursive: true });
        await cp(join(root, 'src-tauri/icons'), join(variant.directory, 'src-tauri/icons'), { recursive: true });
        for (const [target, path] of [[join(root, 'node_modules'), join(variant.directory, 'node_modules')],
            [join(root, '.lowcord/native'), join(variant.directory, '.lowcord/native')]]) {
            try { await access(path); } catch { await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir'); }
        }
    }
    // Each variant uses its own build script, as its release build would.
    const { buildPreload } = await import(pathToFileURL(join(variant.directory, 'scripts/build.mjs')).href);
    await buildPreload({ sourceRoot: variant.directory, release: true });
}
async function electronBenchmarks() {
    for (const variant of variants) await prepareElectron(variant);
    for (let repeat = 0; repeat < iterations; repeat++) for (const variant of repeat % 2 ? variants.slice().reverse() : variants) {
        const dataDir = await mkdtemp(join(tmpdir(), 'lowcord-electron-bench-')); let app;
        try {
            const begin = performance.now();
            app = await electron.launch({ args: [join(variant.directory, 'electron/main.cjs')], env: { ...process.env,
                LOWCORD_TEST: '1', LOWCORD_TEST_UPDATER: '0', LOWCORD_TEST_DATA: dataDir, LOWCORD_TEST_URL: `${url}/electron-child` } });
            const page = await app.firstWindow(); await page.waitForLoadState('load');
            const startupMs = performance.now() - begin;
            const source = await app.evaluate(({ app }) => ({ electron: process.versions.electron, node: process.versions.node,
                metrics: app.getAppMetrics(), updaterLoaded: Object.keys(process.mainModule.require('node:module')._cache).some(path => path.includes('electron-updater')) }));
            const preloadBytes = (await readFile(join(variant.directory, '.lowcord/preload.cjs'))).length;
            const result = { scenario: 'startup', variant: variant.name, repeat, startupMs, preloadBytes, ...source };
            report.results.push(result); console.log(JSON.stringify({ scenario: 'startup', variant: variant.name, repeat, startupMs, updaterLoaded: source.updaterLoaded }));
            if (wanted('playback')) {
                await app.evaluate(({ BrowserWindow }, { root, directory }) => {
                    const { createRedditFixture } = process.mainModule.require(`${root}/tests/fixtures/reddit-playback.cjs`);
                    const { createSocialPosts } = process.mainModule.require(`${directory}/electron/social-posts.cjs`);
                    global.benchmarkPosts = createSocialPosts(createRedditFixture(root).fetchPage);
                    const protocol = BrowserWindow.getAllWindows()[0].webContents.session.protocol;
                    protocol.unhandle('lowcord-media');
                    protocol.handle('lowcord-media', request => global.benchmarkPosts.serve(request));
                }, { root, directory: variant.directory });
                await page.reload();
                const durations = [];
                try {
                    for (let i = 0; i < 12; i++) {
                        const src = await app.evaluate(async (_, id) =>
                            (await global.benchmarkPosts.get(`https://www.reddit.com/comments/abc${id}/`)).media[0].src, i);
                        durations.push(await page.evaluate(async src => {
                            const video = document.createElement('video'); video.muted = true; document.body.append(video);
                            try {
                                const start = performance.now();
                                const frame = new Promise((resolve, reject) => {
                                    video.requestVideoFrameCallback(() => resolve(performance.now() - start));
                                    video.onerror = () => reject(new Error(video.error?.message));
                                });
                                video.src = src; await video.play();
                                const elapsed = await frame;
                                if (!video.videoWidth || video.duration < 1.9) throw new Error('Invalid decoded video');
                                return elapsed;
                            } finally { video.pause(); video.removeAttribute('src'); video.load(); video.remove(); }
                        }, src));
                    }
                } finally { await app.evaluate(async () => { await global.benchmarkPosts.close?.(); }); }
                const sorted = durations.slice().sort((a, b) => a - b);
                const playback = { scenario: 'playback', variant: variant.name, repeat, firstFrameMs: durations,
                    medianMs: median(sorted), p95Ms: sorted[Math.floor(sorted.length * .95)] };
                report.results.push(playback); console.log(JSON.stringify(playback));
            }
            if (wanted('idle')) {
                await pause(1500); await app.evaluate(({ app }) => app.getAppMetrics());
                const samples = [];
                for (let i = 0; i < idleSeconds; i++) {
                    await pause(1000); samples.push(await app.evaluate(({ app }) => app.getAppMetrics()));
                }
                const pid = app.process().pid;
                let native = null;
                if (process.platform !== 'win32') {
                    const processes = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' });
                    native = processes.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line))
                        .filter(match => match && Number(match[2]) === pid && match[4].endsWith('lowcord-native'))
                        .map(match => ({ pid: Number(match[1]), rssMiB: Number(match[3]) / 1024 }));
                }
                const idle = { scenario: 'idle', variant: variant.name, repeat, samples, native,
                    meanCpuPercent: samples.reduce((sum, sample) => sum + sample.reduce((sum, process) => sum + process.cpu.percentCPUUsage, 0), 0) / samples.length,
                    meanWorkingSetMiB: samples.reduce((sum, sample) => sum + sample.reduce((sum, process) => sum + process.memory.workingSetSize, 0), 0) / samples.length / 1024 };
                report.results.push(idle); console.log(JSON.stringify({ scenario: 'idle', variant: variant.name, repeat, meanCpuPercent: idle.meanCpuPercent, meanWorkingSetMiB: idle.meanWorkingSetMiB, native }));
            }
        } finally { if (app) await app.close(); await rm(dataDir, { recursive: true, force: true }); }
    }
}
try {
    await mkdir(resolve(output, '..'), { recursive: true });
    report.sources = {};
    for (const variant of variants) report.sources[variant.name] = Object.fromEntries(await Promise.all(
        ['src-tauri/injection/chat-appearance.js', 'src-tauri/injection/discord.js', 'src-tauri/injection/music-embeds.js', 'src-tauri/injection/social-embeds.js', 'scripts/build.mjs', 'electron/social-posts.cjs', 'electron/main.cjs'].map(async path => [path, hash(await readFile(join(variant.directory, path)))])));
    if (wanted('chat') || wanted('visual') || wanted('startup') || wanted('idle') || wanted('playback') || wanted('dom') || wanted('modules')) await fixtureServer();
    if (wanted('chat')) await chatBenchmarks();
    if (wanted('visual')) await visualChecks();
    if (wanted('dom')) await domBenchmarks();
    if (wanted('modules')) await moduleBenchmarks();
    if (browser) { await browser.close(); browser = null; }
    if (wanted('media')) mediaBenchmarks();
    if (wanted('startup') || wanted('idle') || wanted('playback')) await electronBenchmarks();
    report.summary = [];
    for (const name of ['chat', 'media', 'startup', 'idle', 'playback', 'dom', 'modules']) for (const variant of variants) {
        for (const count of name === 'chat' ? rows : [null]) {
            const results = report.results.filter(result => result.scenario === name && result.variant === variant.name && (count === null || result.rows === count));
            if (!results.length) continue;
            const keys = { chat: ['medianMs', 'p95Ms', 'totalRefreshMs', 'scriptMs'], media: ['peakRssDeltaMiB', 'retainedArrayBuffersMiB', 'elapsedMs', 'cpuMs'],
                startup: ['startupMs', 'preloadBytes'], idle: ['meanCpuPercent', 'meanWorkingSetMiB'], playback: ['medianMs', 'p95Ms'],
                dom: ['scriptMs', 'taskMs', 'wallMs'], modules: ['scriptMs', 'lateStoreFoundMs'] }[name];
            report.summary.push({ scenario: name, variant: variant.name, ...(count === null ? {} : { rows: count }),
                ...Object.fromEntries(keys.map(key => [key, median(results.map(result => result[key]))])) });
        }
    }
    console.log(JSON.stringify({ summary: report.summary, output }));
} catch (error) { report.error = error.stack; throw error; }
finally {
    if (browser) await browser.close();
    if (server && server.exitCode === null) {
        await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
    }
    await writeFile(output, JSON.stringify(report, null, 2));
}
