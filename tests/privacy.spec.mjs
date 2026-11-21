import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { sanitizeImage, pngChunk } = require('../electron/privacy-files.cjs');
const { readFileSync } = require('node:fs');

async function setup(page) {
    await page.goto('/extensions'); await page.waitForFunction(() => window.fixtureReady);
    await page.evaluate(() => {
        const listeners = new Map(), callbacks = new Map();
        window.privacyFixture = { selected: '10', sent: 0, guilds: { 20: { id: '20', name: 'Trip planning' }, 21: { id: '21', name: 'Book club' } },
            emit: name => { for (const callback of listeners.get(name) ?? []) callback(); },
            dispatch: (name, value) => { for (const callback of callbacks.get(name) ?? []) callback(value); } };
        const f = privacyFixture;
        const stores = {
            UserStore: { getCurrentUser: () => ({ id: '1' }), getUser: id => ({ id, username: 'sam', globalName: 'Sam' }) },
            SelectedChannelStore: { getChannelId: () => f.selected },
            ChannelStore: { getChannel: id => id === '30' ? { id, type: 1, recipients: ['2'] } : { id, guild_id: id === '40' ? '21' : '20', name: { 12: 'photos', 40: 'chapter-one' }[id] ?? 'general' } },
            GuildStore: { getGuilds: () => f.guilds, getGuild: id => f.guilds[id] },
            GuildChannelStore: { getChannels: id => ({ SELECTABLE: (id === '20' ? [['10', 'general'], ['12', 'photos']] : [['40', 'chapter-one']]).map(([id, name]) => ({ channel: { id, name } })) }) },
            PrivateChannelSortStore: { getPrivateChannelIds: () => ['30'] },
        };
        for (const [name, store] of Object.entries(stores)) {
            const Store = class {}; Store.displayName = name; Object.setPrototypeOf(store, Store.prototype);
            listeners.set(name, new Set()); store.addChangeListener = callback => listeners.get(name).add(callback);
        }
        const dispatcher = { dispatch() {}, subscribe: (name, callback) => { if (!callbacks.has(name)) callbacks.set(name, new Set()); callbacks.get(name).add(callback); }, unsubscribe() {} };
        f.modules = { privacy: { exports: { ...stores, dispatcher } } };
        webpackChunkdiscord_app[0][2]({ c: f.modules });
        const composer = document.querySelector('.channelTextArea_test');
        const editor = document.createElement('textarea'); editor.setAttribute('aria-label', 'Private draft'); editor.value = 'Keep this draft';
        composer.append(editor);
        editor.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.defaultPrevented) f.sent++; });
    });
    await expect.poll(() => page.evaluate(() => Lowcord.privacy.queue?.owner)).toBe('1');
}
async function inlineSettings(page) {
    await page.setViewportSize({ width: 1440, height: 1024 });
    await page.evaluate(() => {
        const main = document.querySelector('main'); main.style.cssText = 'display:flex;height:100vh';
        main.querySelector('aside').style.cssText = 'width:230px;flex:none;background:#2b2d31;padding:24px;box-sizing:border-box';
        const style = document.createElement('style');
        style.textContent = 'aside ul{list-style:none;margin:0;padding:0}aside .itemContent_test{display:flex;align-items:center;gap:12px}aside svg{width:20px;height:20px;flex:none}aside .item_test{padding:10px 0;font-size:14px}aside .sectionLabel_test h3{font-size:12px;color:#949ba4;margin:24px 0 12px}';
        document.head.append(style);
        main.querySelector('.channelTextArea_test').style.display = 'none';
        main.insertAdjacentHTML('beforeend', '<div class="content_test" style="position:relative;flex:1;min-width:0"><div class="contentHeader_test"><button aria-label="Close" style="position:absolute;right:24px;top:12px;background:transparent;border:0;color:white;font:24px system-ui">×</button></div><div class="page_test">Discord settings</div></div>');
    });
    await page.locator('.lowcord-sidebar-section [role="link"]').filter({ hasText: /^Privacy & Security$/ }).click();
    return page.locator('.lowcord-settings-inline');
}
test('selected privacy design fills native settings and choices persist after reload', async ({ page }, info) => {
    await setup(page); const panel = await inlineSettings(page);
    await expect(panel.locator('.lowcord-privacy-row-main')).toHaveText([/^Media metadata/, /^Attachment inspector/, /^Cover image details/, /^Message expiry/, /^App lock/, /^Walk-away protection/, /^Leave no trace/]);
    await expect(panel.locator('.lowcord-privacy-group > h2')).toHaveText(['Uploads', 'Messages', 'This device']);
    await expect(panel.getByRole('heading', { name: 'Privacy & Security' })).toHaveCount(1);
    await expect(panel.locator('.lowcord-privacy-status')).toContainText('3 of 7 protections on');
    await expect(panel.getByRole('switch', { name: 'Remove media metadata' })).toBeChecked();
    await expect(page.locator('.contentHeader_test button')).toBeVisible();
    await expect(page.locator('.lowcord-settings-backdrop')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('privacy-settings.png') });
    const row = panel.getByRole('button', { name: /^Attachment inspector/ });
    await row.click(); await expect(row).toHaveAttribute('aria-expanded', 'true');
    await panel.getByRole('button', { name: /^Media metadata/ }).click(); await expect(row).toHaveAttribute('aria-expanded', 'false');
    await panel.getByRole('switch', { name: 'Attachment inspector' }).click();
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await page.reload(); await page.waitForFunction(() => window.fixtureReady);
    expect(await page.evaluate(() => Lowcord.privacy.state)).toEqual({ metadata: true, inspector: false, walkAway: true, coverAsk: false, appLock: false, lockAfter: 5, lockShortcut: 'Mod+Shift+L' });
});
test('privacy controls remain within the native column in a narrow light window', async ({ page }, info) => {
    await setup(page); const panel = await inlineSettings(page);
    await page.setViewportSize({ width: 520, height: 700 });
    await page.evaluate(() => {
        for (const [name, value] of Object.entries({ '--background-primary': '#fff', '--background-secondary': '#f2f3f5', '--text-normal': '#202126', '--text-muted': '#5b6068', '--header-primary': '#111', '--border-subtle': '#ddd' })) document.documentElement.style.setProperty(name, value);
    });
    const bounds = await panel.locator('.lowcord-settings-body').evaluate(node => ({ width: node.clientWidth, content: node.scrollWidth }));
    expect(bounds.content).toBeLessThanOrEqual(bounds.width + 1);
    await panel.getByRole('button', { name: /^Message expiry/ }).click();
    await panel.getByRole('button', { name: 'Create rule' }).scrollIntoViewIfNeeded();
    await expect(panel.getByRole('button', { name: 'Create rule' })).toBeVisible();
    const after = await panel.locator('.lowcord-settings-body').evaluate(node => ({ width: node.clientWidth, content: node.scrollWidth }));
    expect(after.content).toBeLessThanOrEqual(after.width + 1);
    await page.screenshot({ path: info.outputPath('privacy-narrow-light.png') });
});
test('expiry rechecks message ownership against Discord before deletion', async ({ page }) => {
    await setup(page);
    const result = await page.evaluate(async () => {
        const queue = Lowcord.privacy.queue;
        queue.addRule({ id: 'verify', scope: 'channel', target: '10', hours: 1, attachmentsOnly: false });
        queue.observe({ id: '100', channel_id: '10', author: { id: '1' }, timestamp: Date.now() + 1 });
        queue.state.messages[0].deadline = 0;
        let deleted = 0;
        Object.defineProperty(Lowcord, 'RestAPI', { value: { get: async () => ({ body: [{ id: '100', author: { id: '2' } }] }), del: async () => { deleted++; }, patch: async () => { deleted++; } } });
        await queue.tick(); return { deleted, preserved: queue.state.messages[0].preserved };
    });
    expect(result).toEqual({ deleted: 0, preserved: true });
});
test('expiry UI requires a scope and tracks only new own message IDs', async ({ page }) => {
    await setup(page); const panel = await inlineSettings(page);
    await panel.getByRole('button', { name: /^Message expiry/ }).click();
    // The open chat is preselected: its server, then the channel itself.
    await expect(panel.getByRole('radio', { name: 'Trip planning' })).toHaveAttribute('aria-checked', 'true');
    await expect(panel.getByRole('combobox', { name: 'Channel' })).toHaveValue('10');
    await panel.getByRole('group', { name: 'Delete after' }).getByRole('button', { name: '1 hour' }).click();
    await panel.getByRole('button', { name: 'Create rule' }).click();
    expect(await page.evaluate(() => Lowcord.privacy.queue.state.rules.map(rule => [rule.id, rule.hours]))).toEqual([['channel:10', 1]]);
    await page.evaluate(() => {
        privacyFixture.dispatch('MESSAGE_CREATE', { message: { id: '100', channel_id: '10', author: { id: '1' }, timestamp: new Date().toISOString(), content: 'SECRET' } });
        privacyFixture.dispatch('MESSAGE_CREATE', { message: { id: '101', channel_id: '10', author: { id: '2' }, timestamp: new Date().toISOString() } });
    });
    await expect(panel.getByRole('button', { name: 'Preserve', exact: true })).toHaveCount(1);
    await panel.getByRole('button', { name: 'Preserve', exact: true }).click();
    expect(await page.evaluate(() => Lowcord.privacy.queue.state.messages[0].preserved)).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('lowcord.expiry.1').includes('SECRET'))).toBe(false);
    await panel.getByRole('button', { name: 'Remove rule', exact: true }).click();
    expect(await page.evaluate(() => Lowcord.privacy.queue.state.messages.length)).toBe(0);
});
test('metadata preparation passes sanitized bytes to the native chooser flow', async ({ page }) => {
    await page.exposeFunction('sanitizeFixture', bytes => { const result = sanitizeImage(Uint8Array.from(bytes)); return { ...result, bytes: result.bytes ? Array.from(result.bytes) : null }; });
    await setup(page);
    await page.evaluate(() => {
        window.__LOWCORD_NATIVE__ = { sanitizeImage: async bytes => { const result = await sanitizeFixture(Array.from(bytes)); return { ...result, bytes: new Uint8Array(result.bytes) }; } };
        const composer = document.querySelector('.channelTextArea_test');
        composer.insertAdjacentHTML('beforeend', '<input type="file" aria-label="Attach private image">');
        composer.querySelector('input[type=file]').addEventListener('change', async event => { privacyFixture.uploaded = Array.from(new Uint8Array(await event.target.files[0].arrayBuffer())); });
    });
    const source = readFileSync('tests/fixtures/media/sample.png'), secret = pngChunk('tEXt', Buffer.from('Author\0SECRET LOCATION'));
    await page.getByLabel('Attach private image').setInputFiles({ name: 'private.png', mimeType: 'image/png', buffer: Buffer.concat([source.subarray(0, 33), secret, source.subarray(33)]) });
    await expect.poll(() => page.evaluate(() => Boolean(privacyFixture.uploaded))).toBe(true);
    const output = Buffer.from(await page.evaluate(() => privacyFixture.uploaded)); expect(output).toEqual(source);
});

test('expiry reads through history, deletes own messages and strips only attachments when asked', async ({ page }) => {
    await setup(page);
    const result = await page.evaluate(async () => {
        const queue = Lowcord.privacy.queue, calls = [];
        const bodies = { '100': { id: '100', author: { id: '1' }, content: 'hello' }, '101': { id: '101', author: { id: '1' }, content: 'see file', attachments: [{ id: '9' }] }, '102': { id: '102', author: { id: '1' }, content: '', attachments: [{ id: '8' }] } };
        Object.defineProperty(Lowcord, 'RestAPI', { value: {
            get: async request => { calls.push(['get', request.url, request.query]); return { body: [bodies[request.query.around]] }; },
            del: async request => { calls.push(['del', request.url]); }, patch: async request => { calls.push(['patch', request.url, request.body]); } } });
        queue.addRule({ id: 'all', scope: 'channel', target: '10', hours: 1, attachmentsOnly: false });
        queue.addRule({ id: 'files', scope: 'channel', target: '11', hours: 1, attachmentsOnly: true });
        const now = Date.now() + 1;
        queue.observe({ id: '100', channel_id: '10', author: { id: '1' }, timestamp: now });
        queue.observe({ id: '101', channel_id: '11', author: { id: '1' }, timestamp: now, attachments: [{}] });
        queue.observe({ id: '102', channel_id: '11', author: { id: '1' }, timestamp: now, attachments: [{}] });
        for (const message of queue.state.messages) message.deadline = 0;
        await queue.tick(); await queue.tick(); await queue.tick();
        return { calls, left: queue.state.messages.length };
    });
    expect(result.left).toBe(0);
    expect(result.calls).toEqual([
        ['get', '/channels/10/messages', { around: '100', limit: 1 }], ['del', '/channels/10/messages/100'],
        ['get', '/channels/11/messages', { around: '101', limit: 1 }], ['patch', '/channels/11/messages/101', { attachments: [] }],
        ['get', '/channels/11/messages', { around: '102', limit: 1 }], ['del', '/channels/11/messages/102']]);
});
for (const [name, mimeType] of [['IMG_0001.heic', 'image/heic'], ['clip.mp4', 'video/mp4'], ['notes.pdf', 'application/pdf']])
test(`unsupported metadata format ${name} attaches without a popup`, async ({ page }) => {
    await setup(page);
    await page.evaluate(() => {
        window.__LOWCORD_NATIVE__ = { sanitizeImage: async () => { throw new Error('should not run'); } };
        const composer = document.querySelector('.channelTextArea_test');
        composer.insertAdjacentHTML('beforeend', '<input type="file" aria-label="Attach photo">');
        composer.querySelector('input[type=file]').addEventListener('change', event => { privacyFixture.uploadedName = event.target.files[0]?.name; });
    });
    await page.getByLabel('Attach photo').setInputFiles({ name, mimeType, buffer: Buffer.from('original bytes') });
    // Anonymous filenames may rename it; the file still passes through.
    await expect.poll(() => page.evaluate(() => privacyFixture.uploadedName)).toMatch(new RegExp(`\\.${name.split('.').pop()}$`));
    await expect(page.locator('.lowcord-toast')).toHaveCount(0);
});

test('Enter sends straight away: there is no send delay or pending bar', async ({ page }) => {
    await setup(page);
    await page.getByRole('textbox', { name: 'Private draft' }).press('Enter');
    expect(await page.evaluate(() => privacyFixture.sent)).toBe(1);
    await expect(page.locator('.lowcord-send-buffer')).toHaveCount(0);
    expect(await page.evaluate(() => ['sendBuffer', 'resumeSend'].some(name => name in Lowcord.privacy))).toBe(false);
});
test('a pasted image reaches the message box cleaned, even when file names are anonymised too', async ({ page }) => {
    await page.exposeFunction('sanitizeFixture', bytes => { const result = sanitizeImage(Uint8Array.from(bytes)); return { ...result, bytes: result.bytes ? Array.from(result.bytes) : null }; });
    await setup(page);
    const source = readFileSync('tests/fixtures/media/sample.png'), secret = pngChunk('tEXt', Buffer.from('Author\0SECRET LOCATION'));
    const delivered = await page.evaluate(async bytes => {
        window.__LOWCORD_NATIVE__ = { sanitizeImage: async input => { const result = await sanitizeFixture(Array.from(input)); return { ...result, bytes: new Uint8Array(result.bytes) }; } };
        const editor = document.querySelector('[aria-label="Private draft"]'), arrived = [];
        // Discord's own paste handler: it only sees events nobody cancelled.
        editor.addEventListener('paste', event => { if (!event.defaultPrevented) arrived.push(...event.clipboardData.files); });
        const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], 'image.png', { type: 'image/png' }));
        editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
        for (let i = 0; i < 100 && !arrived.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
        return Promise.all(arrived.map(async file => ({ name: file.name, bytes: Array.from(new Uint8Array(await file.arrayBuffer())) })));
    }, Array.from(Buffer.concat([source.subarray(0, 33), secret, source.subarray(33)])));
    expect(delivered).toHaveLength(1);
    expect(delivered[0].name).not.toBe('image.png');
    expect(Buffer.from(delivered[0].bytes)).toEqual(source);
    await expect(page.locator('.lowcord-toast')).not.toContainText('Wait for the current images');
});

test('expiry picks whole servers and direct messages from searchable lists', async ({ page }) => {
    await setup(page); const panel = await inlineSettings(page);
    await panel.getByRole('button', { name: /^Message expiry/ }).click();
    await panel.getByRole('radio', { name: 'Book club' }).click();
    await expect(panel.getByRole('combobox', { name: 'Channel' })).toHaveValue('');
    await panel.getByRole('button', { name: 'Create rule' }).click();
    await panel.getByRole('group', { name: 'Rule applies to' }).getByRole('button', { name: 'Direct messages' }).click();
    await expect(panel.getByRole('button', { name: 'Create rule' })).toBeDisabled();
    await panel.getByRole('searchbox', { name: 'Search direct messages' }).fill('zzz');
    await expect(panel.getByText('No matches.')).toBeVisible();
    await panel.getByRole('searchbox', { name: 'Search direct messages' }).fill('sa');
    await panel.getByRole('radio', { name: 'Sam' }).click();
    await panel.getByRole('group', { name: 'Remove' }).getByRole('button', { name: 'Only attachments' }).click();
    await panel.getByRole('button', { name: 'Create rule' }).click();
    expect(await page.evaluate(() => Lowcord.privacy.queue.state.rules.map(rule => [rule.id, rule.scope, rule.attachmentsOnly])))
        .toEqual([['server:21', 'server', false], ['channel:30', 'channel', true]]);
    await expect(panel.getByText('Book club', { exact: true }).last()).toBeVisible();
});
test('the expiry preview shows exactly what each choice removes', async ({ page }) => {
    await setup(page); const panel = await inlineSettings(page);
    await panel.getByRole('button', { name: /^Message expiry/ }).click();
    const preview = panel.locator('.lowcord-privacy-preview');
    await expect(preview).toContainText('Now · #general');
    await expect(preview).toContainText('After 24 hours');
    await expect(preview.locator('.lowcord-privacy-ghost')).toHaveCount(3);
    await panel.getByRole('group', { name: 'Delete after' }).getByRole('button', { name: '7 days' }).click();
    await expect(preview).toContainText('After 7 days');
    await panel.getByRole('group', { name: 'Remove' }).getByRole('button', { name: 'Only attachments' }).click();
    // Text survives, a mixed message loses its file, a file-only message goes.
    await expect(preview.locator('.lowcord-privacy-ghost')).toHaveCount(1);
    await expect(preview).toContainText('Attachment removed');
    await expect(preview).toContainText('Looks amazing');
    await expect(panel.locator('.lowcord-privacy-summary')).toContainText('lose their attachments 7 days after you send them');
});

test('mixed uploads clean supported images and attach unsupported files without a warning', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => {
        Lowcord.extensions.set('anonymiseFileNames', false);
        privacyFixture.sanitized = 0;
        window.__LOWCORD_NATIVE__ = { sanitizeImage: async () => {
            privacyFixture.sanitized++;
            return { status: 'processed', type: 'image/png', bytes: new Uint8Array([1, 2, 3]) };
        } };
        const composer = document.querySelector('.channelTextArea_test');
        composer.insertAdjacentHTML('beforeend', '<input type="file" multiple aria-label="Mixed attachments">');
        composer.querySelector('input[type=file]').addEventListener('change', async event => {
            privacyFixture.uploaded = await Promise.all([...event.target.files].map(async file => ({
                name: file.name, bytes: Array.from(new Uint8Array(await file.arrayBuffer()))
            })));
        });
    });
    await page.getByLabel('Mixed attachments').setInputFiles([
        { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from([9, 9]) },
        { name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.from([4, 5]) },
        { name: 'photo.heic', mimeType: 'image/heic', buffer: Buffer.from([6, 7]) }
    ]);
    await expect.poll(() => page.evaluate(() => privacyFixture.uploaded)).toEqual([
        { name: 'photo.png', bytes: [1, 2, 3] }, { name: 'clip.mp4', bytes: [4, 5] }, { name: 'photo.heic', bytes: [6, 7] }
    ]);
    expect(await page.evaluate(() => privacyFixture.sanitized)).toBe(1);
    await expect(page.locator('.lowcord-toast')).toContainText('Metadata removed from 1 image.');
    await expect(page.locator('.lowcord-toast-error')).toHaveCount(0);
});
function voiceFixture(page, state) {
    return page.evaluate(state => {
        const f = window.voiceFixture = { ...state, dispatched: [] };
        const stores = {
            MediaEngineStore: { isSelfMute: () => f.muted, isVideoEnabled: () => f.video },
            ApplicationStreamingStore: { getCurrentUserActiveStream: () => f.stream },
        };
        for (const [name, store] of Object.entries(stores)) { const Store = class {}; Store.displayName = name; Object.setPrototypeOf(store, Store.prototype); }
        const selected = Lowcord.store('SelectedChannelStore');
        selected.getVoiceChannelId = () => f.voice;
        const actions = { toggleSelfMute: () => { if (!f.stuck) f.muted = true; }, setVideoEnabled: value => { f.video = value; } };
        const dispatcher = { dispatch: action => { f.dispatched.push(action); if (action.type === 'STREAM_STOP') f.stream = null; }, subscribe() {}, unsubscribe() {} };
        webpackChunkdiscord_app[0][2]({ c: { voice: { exports: { ...stores, actions } } } });
        Object.defineProperty(Lowcord, 'Dispatcher', { value: dispatcher, configurable: true });
    }, state);
}
const voice = { muted: false, video: true, voice: '50', stream: { streamType: 'guild', guildId: '20', channelId: '50', ownerId: '1' } };
test('walk-away protection stops everything live and reports it on return', async ({ page }) => {
    await setup(page); await voiceFixture(page, voice);
    await page.evaluate(() => Lowcord.privacy.walkAwayChanged('away'));
    await page.waitForTimeout(350);
    expect(await page.evaluate(() => voiceFixture)).toMatchObject({ muted: true, video: false, stream: null, dispatched: [
        { type: 'STREAM_CLOSE', streamKey: 'guild:20:50:1' }, { type: 'STREAM_STOP', streamKey: 'guild:20:50:1', appContext: 'APP' }] });
    await expect(page.locator('.lowcord-toast')).toHaveCount(0);
    await page.evaluate(() => Lowcord.privacy.walkAwayChanged('back'));
    await expect(page.locator('.lowcord-toast')).toContainText('Microphone muted, camera turned off, screen share stopped');
    expect(await page.evaluate(() => Lowcord.privacy.report.totals.walkAway)).toBe(1);
});
test('walk-away protection says so when the microphone stays live, and respects the switch', async ({ page }) => {
    await setup(page); await voiceFixture(page, { ...voice, stuck: true, stream: null, video: false });
    await page.evaluate(() => Lowcord.privacy.walkAwayChanged('away'));
    await page.waitForTimeout(350);
    await page.evaluate(() => Lowcord.privacy.walkAwayChanged('back'));
    await expect(page.locator('.lowcord-toast')).toContainText('could not confirm: microphone muted');
    await page.evaluate(() => { voiceFixture.stuck = false; Lowcord.privacy.set({ walkAway: false }); Lowcord.privacy.walkAwayChanged('away'); });
    await page.waitForTimeout(350);
    expect(await page.evaluate(() => voiceFixture.muted)).toBe(false);
});
async function attachedFile(page) {
    await page.evaluate(() => {
        Lowcord.extensions.set('anonymiseFileNames', false);
        window.__LOWCORD_NATIVE__ = { sanitizeImage: async bytes => ({ status: 'processed', type: 'image/png', bytes }) };
        const composer = document.querySelector('.channelTextArea_test');
        composer.insertAdjacentHTML('beforeend', '<input type="file" aria-label="Cover test">');
        composer.querySelector('[aria-label="Cover test"]').addEventListener('change', event => { if (event.target.files[0]) privacyFixture.attached = event.target.files[0]; });
    });
}
const whitePng = page => page.evaluate(async () => {
    const canvas = new OffscreenCanvas(200, 100), context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, 200, 100);
    return [...new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())];
});
// Stands in for the native bridge: paste() pastes `clipboard` like the OS would.
async function editBridge(page) {
    await page.exposeFunction('sanitizeFixture', bytes => { const result = sanitizeImage(Uint8Array.from(bytes)); return { ...result, bytes: result.bytes ? Array.from(result.bytes) : null }; });
    const png = await whitePng(page);
    await page.evaluate(png => {
        const editor = document.querySelector('[aria-label="Private draft"]');
        window.editFixture = { arrived: [], pastes: [], clipboard: [new File([new Uint8Array(png)], 'shot.png', { type: 'image/png' })] };
        window.__LOWCORD_NATIVE__ = {
            sanitizeImage: async input => { const result = await sanitizeFixture(Array.from(input)); return { ...result, bytes: result.bytes && new Uint8Array(result.bytes) }; },
            paste: async plain => {
                editFixture.pastes.push(plain);
                const data = new DataTransfer();
                for (const file of plain ? [] : editFixture.clipboard) data.items.add(file);
                editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
            },
            downloadDroppedImage: async url => ({ name: 'from-chat.png', type: 'image/png', data: new Uint8Array(png), url }),
        };
        editor.addEventListener('paste', event => { if (!event.defaultPrevented) editFixture.arrived.push(...event.clipboardData.files); });
    }, png);
}
test('Cmd/Ctrl+Shift+V pastes an image into the editor, and pastes text as plain text', async ({ page }) => {
    await setup(page); await editBridge(page);
    const editor = page.getByLabel('Private draft');
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+Shift+V');
    const canvas = page.locator('.lowcord-edit-stage canvas');
    await expect(canvas).toBeVisible();
    // Crop is the starting tool for an image edited on demand.
    await page.getByRole('button', { name: 'Square' }).click();
    await page.getByRole('button', { name: 'Attach image' }).click();
    await expect.poll(() => page.evaluate(() => editFixture.arrived.length)).toBe(1);
    expect(await page.evaluate(async () => { const bitmap = await createImageBitmap(editFixture.arrived[0]); return [bitmap.width, bitmap.height]; })).toEqual([100, 100]);
    // A plain Cmd/Ctrl+V still goes straight to Discord.
    await page.evaluate(() => { editFixture.arrived.length = 0; });
    await page.evaluate(() => editFixture.clipboard = []);
    await page.keyboard.press('ControlOrMeta+Shift+V');
    await expect.poll(() => page.evaluate(() => editFixture.pastes)).toEqual([false, false, true]);
    await expect(canvas).toHaveCount(0);
});
// Discord's draft attachments: a store, its upload actions and the cards it
// renders. setFile adds the new file at the end, as Discord's does.
async function uploadFixture(page) {
    await page.evaluate(() => {
        const f = privacyFixture, uploads = [];
        let next = 1;
        const emit = () => { render(); f.emit('UploadAttachmentStore'); };
        const add = file => uploads.push({ id: `upload${next++}`, filename: file.name, item: { file, platform: 1 }, spoiler: false, description: null });
        const UploadAttachmentStore = { getUploads: id => id === f.selected ? uploads : [] };
        const actions = {
            addFile: ({ file }) => { add(file.file); emit(); },
            setFile: ({ file, id }) => { const at = uploads.findIndex(item => item.id === id); uploads.splice(at, 1); add(file.file); emit(); },
            setUploads: ({ uploads: list }) => { uploads.splice(0, uploads.length, ...list); emit(); },
            update: (channel, id, draft, { spoiler, description }) => { Object.assign(uploads.find(item => item.id === id), { spoiler, description }); emit(); },
            remove: (channel, id) => { uploads.splice(uploads.findIndex(item => item.id === id), 1); emit(); },
        };
        const Store = class {}; Store.displayName = 'UploadAttachmentStore'; Object.setPrototypeOf(UploadAttachmentStore, Store.prototype);
        UploadAttachmentStore.addChangeListener = () => {};
        f.modules.uploads = { exports: { UploadAttachmentStore, actions } };
        const list = document.createElement('ul'); list.className = 'channelAttachmentArea_test';
        document.querySelector('.channelTextArea_test').prepend(list);
        function render() {
            list.replaceChildren(...uploads.map(upload => {
                const card = document.createElement('li');
                card.setAttribute('data-list-item-id', `attachments___${upload.id}`);
                card.innerHTML = `<div class="uploadContainer_test"><div class="mediaContainer_test" style="width:160px;height:100px"><img class="media_test" alt=""></div>
                    <div class="filename_test">${upload.filename}</div><div class="actionBar_test" aria-label="Upload Attachment Utilities"></div></div>`;
                card.querySelector('img').src = URL.createObjectURL(upload.item.file);
                return card;
            }));
        }
        window.uploadFixture = { uploads, actions };
    });
}
test('the pencil on an attached image edits it in place, keeping its place, spoiler and description', async ({ page }) => {
    await setup(page); await uploadFixture(page);
    const png = await whitePng(page);
    await page.evaluate(png => {
        for (const name of ['first.png', 'second.png', 'notes.pdf']) uploadFixture.actions.addFile({ file: { file: new File([new Uint8Array(png)], name, { type: name.endsWith('pdf') ? 'application/pdf' : 'image/png' }) } });
        uploadFixture.actions.update('10', 'upload2', 0, { spoiler: true, description: 'Alt text' });
    }, png);
    const buttons = page.getByRole('button', { name: 'Edit image' });
    // Only images and videos get the pencil.
    await expect(buttons).toHaveCount(2);
    await buttons.nth(1).click();
    await expect(page.locator('.lowcord-edit-stage canvas')).toBeVisible();
    await page.getByRole('button', { name: 'Rotate left' }).click();
    await page.getByRole('button', { name: 'Save image' }).click();
    await expect.poll(() => page.evaluate(() => uploadFixture.uploads.map(item => `${item.id} ${item.filename}`))).toEqual(['upload1 first.png', 'upload4 second.png', 'upload3 notes.pdf']);
    expect(await page.evaluate(async () => {
        const upload = uploadFixture.uploads[1], bitmap = await createImageBitmap(upload.item.file);
        return [upload.id, upload.spoiler, upload.description, bitmap.width, bitmap.height];
    })).toEqual(['upload4', true, 'Alt text', 100, 200]);
    // The re-rendered card gets its pencil back; cancelling changes nothing.
    await expect(buttons).toHaveCount(2);
    await buttons.first().click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    expect(await page.evaluate(() => uploadFixture.uploads.map(item => item.id))).toEqual(['upload1', 'upload4', 'upload3']);
    await page.evaluate(() => Lowcord.extensions.set('coverImages', false));
    await expect(buttons).toHaveCount(0);
});
// Stands in for the native video job; records what the page sends.
async function videoBridge(page, files) {
    const webm = [...readFileSync('tests/fixtures/media/sample.webm')];
    await page.evaluate(([webm, files]) => {
        window.videoJobs = [];
        window.__LOWCORD_NATIVE__ = { videoCompression: async (action, ...args) => {
            videoJobs.push([action, action === 'append' ? args[1].byteLength : args[0]]);
            if (action === 'begin') return { id: 'job1' };
            if (action === 'finish') return { size: 16, type: 'video/mp4', extension: 'mp4' };
            if (action === 'read') return new Uint8Array(16).fill(7);
            return null;
        } };
        for (const name of files) uploadFixture.actions.addFile({ file: { file: new File([new Uint8Array(webm)], name, { type: 'video/webm' }) } });
    }, [webm, files]);
    return webm.length;
}
test('the pencil on an attached video sends its crop as numbers and swaps in the encoded MP4', async ({ page }) => {
    await setup(page); await uploadFixture(page);
    const size = await videoBridge(page, ['clip.webm']);
    await page.getByRole('button', { name: 'Edit video' }).click();
    await expect(page.getByRole('heading', { name: 'Edit video' })).toBeVisible();
    await page.getByRole('button', { name: 'Square' }).click();
    await page.getByRole('button', { name: 'Rotate right' }).click();
    await page.getByRole('button', { name: 'Save video' }).click();
    await expect.poll(() => page.evaluate(() => uploadFixture.uploads[0]?.filename)).toBe('clip.mp4');
    const begin = await page.evaluate(() => videoJobs[0]);
    expect(begin[0]).toBe('begin');
    expect(begin[1]).toMatchObject({ kind: 'edit', sizes: [size], edit: { transpose: 1, hflip: false, vflip: false, width: 90, height: 160, boxes: [], mute: false } });
    expect(begin[1].edit.crop).toEqual({ x: 0, y: 35, width: 90, height: 90 });
    expect(begin[1].edit.clips).toEqual([{ start: 0, end: 2.028 }]);
    expect(await page.evaluate(() => videoJobs.map(([action]) => action))).toEqual(['begin', 'append', 'finish', 'read', 'cancel']);
    expect(await page.evaluate(() => [uploadFixture.uploads[0].item.file.type, uploadFixture.uploads[0].item.file.size])).toEqual(['video/mp4', 16]);
});
test('an edited video over the chat limit is compressed to fit, as an attached one would be', async ({ page }) => {
    await setup(page); await uploadFixture(page);
    // A direct message: the 20 MB limit.
    await page.evaluate(() => { privacyFixture.selected = '30'; });
    await videoBridge(page, ['clip.webm']);
    await page.evaluate(() => {
        const jobs = new Map();
        __LOWCORD_NATIVE__.videoCompression = async (action, ...args) => {
            videoJobs.push([action, action === 'append' ? args[1].byteLength : args[0]]);
            if (action === 'begin') { const id = `job${jobs.size + 1}`; jobs.set(id, args[0]); return { id }; }
            const job = jobs.get(args[0]);
            // The edit comes out at 21 MB; compression brings it to 16 bytes.
            const size = job.kind === 'edit' ? 21_000_000 : 16;
            if (action === 'finish') return { size, type: 'video/mp4', extension: 'mp4' };
            if (action === 'read') return new Uint8Array(Math.min(1024 * 1024, size - args[1])).fill(job.kind === 'edit' ? 1 : 2);
            return null;
        };
    });
    await page.getByRole('button', { name: 'Edit video' }).click();
    await page.getByRole('button', { name: 'Mute' }).click();
    await page.getByRole('button', { name: 'Save video' }).click();
    await expect.poll(() => page.evaluate(() => uploadFixture.uploads[0]?.item.file.size)).toBe(16);
    const begins = await page.evaluate(() => videoJobs.filter(([action]) => action === 'begin').map(([, options]) => options));
    expect(begins.map(options => options.kind)).toEqual(['edit', 'video']);
    expect(begins[0].edit.mute).toBe(true);
    expect(begins[1]).toMatchObject({ size: 21_000_000, limit: 20_000_000 });
    expect(await page.evaluate(() => uploadFixture.uploads[0].filename)).toBe('clip.mp4');
});
test('a video is trimmed with the yellow handles, can be muted, and plays in the editor', async ({ page }, info) => {
    await setup(page); await uploadFixture(page);
    await videoBridge(page, ['clip.webm']);
    await page.getByRole('button', { name: 'Edit video' }).click();
    const start = page.getByRole('slider', { name: 'Trim start' }), end = page.getByRole('slider', { name: 'Trim end' });
    await expect(start).toHaveAttribute('aria-valuenow', '0.0');
    await expect(end).toHaveAttribute('aria-valuenow', '2.0');
    // Keyboard: Shift moves a second; plain arrows a tenth. The ends keep half a second apart.
    await start.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
    await expect(start).toHaveAttribute('aria-valuenow', '0.2');
    await end.focus(); await page.keyboard.press('Shift+ArrowLeft'); await page.keyboard.press('Shift+ArrowLeft');
    await expect(end).toHaveAttribute('aria-valuenow', '0.7');
    // Pointer: drag the end handle to about 3/4 of the bar.
    const track = await page.locator('.lowcord-trim-track').boundingBox(), handle = await end.boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down(); await page.mouse.move(track.x + track.width * .75, track.y + 10, { steps: 4 }); await page.mouse.up();
    await expect.poll(async () => Number(await end.getAttribute('aria-valuenow'))).toBeGreaterThan(1.4);
    // The readout counts from the trimmed start: dragging the end shows its frame.
    await expect(page.locator('.lowcord-trim-time')).toHaveText(/^0:01\.\d \/ 0:01\.\d$/);
    const mute = page.getByRole('button', { name: 'Mute' });
    await mute.click();
    await expect(mute).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: /^Play/ }).click();
    await expect(page.getByRole('button', { name: /^Pause/ })).toBeVisible();
    await page.screenshot({ path: info.outputPath('trim.png') });
});
test('attached videos can be joined in order, then their own attachments are removed', async ({ page }, info) => {
    await setup(page); await uploadFixture(page);
    const size = await videoBridge(page, ['first.webm', 'second.webm', 'third.webm']);
    await page.getByRole('button', { name: 'Edit video' }).first().click();
    await page.getByRole('button', { name: 'Add third.webm' }).click();
    await page.getByRole('button', { name: 'Add second.webm' }).click();
    const clips = page.locator('.lowcord-clip-list li');
    await expect(clips).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Add second.webm' })).toHaveCount(0);
    // Put second before third, then trim third.
    await page.getByRole('button', { name: 'Move second.webm earlier' }).click();
    await expect(clips.locator('.lowcord-clip-name')).toHaveText(['1. first.webm', '2. second.webm', '3. third.webm']);
    // One timeline holds all three clips, each with its own trim handles.
    await expect(page.locator('.lowcord-trim-segment')).toHaveCount(3);
    await expect(page.getByRole('slider', { name: /^Trim start, clip \d$/ })).toHaveCount(3);
    await page.getByRole('slider', { name: 'Trim start, clip 3' }).focus(); await page.keyboard.press('Shift+ArrowRight');
    await expect(page.locator('.lowcord-trim-time')).toHaveText(/ \/ 0:05\.1$/);
    // Clicking in the second clip's film moves the playhead there: 2.0 s of clip one, then 1.0 s.
    const second = await page.locator('.lowcord-trim-segment').nth(1).boundingBox();
    await page.mouse.click(second.x + second.width / 2, second.y + second.height / 2);
    await expect(page.locator('.lowcord-trim-time')).toHaveText(/^0:03\.0 \//);
    await expect(clips.nth(1)).toHaveClass('is-current');
    await page.screenshot({ path: info.outputPath('join.png') });
    await page.getByRole('button', { name: 'Save video' }).click();
    await expect.poll(() => page.evaluate(() => uploadFixture.uploads.map(item => item.filename))).toEqual(['first.mp4']);
    const begin = await page.evaluate(() => videoJobs[0][1]);
    expect(begin.sizes).toEqual([size, size, size]);
    expect(begin.edit.clips).toEqual([{ start: 0, end: 2.028 }, { start: 0, end: 2.028 }, { start: 1, end: 2.028 }]);
    expect(await page.evaluate(() => videoJobs.filter(([action]) => action === 'append').length)).toBe(3);
});
test('asking before attaching covers pixels permanently and cancelling attaches nothing', async ({ page }, info) => {
    await setup(page); await attachedFile(page);
    await page.evaluate(() => Lowcord.privacy.set({ coverAsk: true }));
    const buffer = Buffer.from(await whitePng(page));
    await page.getByLabel('Cover test').setInputFiles({ name: 'address.png', mimeType: 'image/png', buffer });
    const canvas = page.locator('.lowcord-edit-stage canvas');
    await expect(canvas).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(canvas).toHaveCount(0);
    expect(await page.evaluate(() => Boolean(privacyFixture.attached))).toBe(false);
    await page.getByLabel('Cover test').setInputFiles({ name: 'address2.png', mimeType: 'image/png', buffer });
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width * .1, box.y + box.height * .2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width * .6, box.y + box.height * .8); await page.mouse.up();
    await expect(page.locator('.lowcord-capture-count')).toHaveText('1 area covered');
    await page.screenshot({ path: info.outputPath('cover-image.png') });
    await page.getByRole('button', { name: 'Attach image' }).click();
    await expect.poll(() => page.evaluate(() => privacyFixture.attached?.name)).toBe('address2.png');
    expect(await page.evaluate(async () => {
        const bitmap = await createImageBitmap(privacyFixture.attached), canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        return [[...context.getImageData(60, 50, 1, 1).data], [...context.getImageData(190, 50, 1, 1).data]];
    })).toEqual([[0, 0, 0, 255], [255, 255, 255, 255]]);
    expect(await page.evaluate(() => Lowcord.privacy.report.totals.covered)).toBe(1);
});
test('the editor rotates, crops to a shape and flips before attaching', async ({ page }, info) => {
    await setup(page); await attachedFile(page);
    await page.evaluate(() => Lowcord.privacy.set({ coverAsk: true }));
    // Left half red, right half blue.
    const buffer = Buffer.from(await page.evaluate(async () => {
        const canvas = new OffscreenCanvas(200, 100), context = canvas.getContext('2d');
        context.fillStyle = '#f00'; context.fillRect(0, 0, 100, 100); context.fillStyle = '#00f'; context.fillRect(100, 0, 100, 100);
        return [...new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())];
    }));
    await page.getByLabel('Cover test').setInputFiles({ name: 'halves.png', mimeType: 'image/png', buffer });
    await expect(page.getByRole('heading', { name: 'Edit image' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cover areas' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Rotate right' }).click();
    await page.getByRole('button', { name: 'Square' }).click();
    await page.getByRole('button', { name: 'Flip vertically' }).click();
    await expect(page.locator('.lowcord-capture-count')).toHaveText('100 × 100');
    await page.screenshot({ path: info.outputPath('edit-image.png') });
    // Holding compare shows the untouched 200 × 100 original, then the edit again.
    const compare = page.getByRole('button', { name: 'Hold to see the original' });
    await compare.hover(); await page.mouse.down();
    await expect.poll(() => page.locator('.lowcord-edit-stage canvas').evaluate(node => node.width / node.height)).toBe(2);
    await page.mouse.up();
    await expect.poll(() => page.locator('.lowcord-edit-stage canvas').evaluate(node => node.width / node.height)).toBe(1 / 2);
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.getByRole('button', { name: 'Redo' }).click();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('button', { name: 'Redo' })).toBeEnabled();
    await page.getByRole('button', { name: 'Flip vertically' }).click();
    await expect(page.getByRole('button', { name: 'Redo' })).toBeDisabled();
    await page.getByRole('button', { name: 'Attach image' }).click();
    await expect.poll(() => page.evaluate(() => privacyFixture.attached?.name)).toBe('halves.png');
    // Turned clockwise, red is on top; the flip puts blue on top of the square.
    expect(await page.evaluate(async () => {
        const bitmap = await createImageBitmap(privacyFixture.attached), canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        return [bitmap.width, bitmap.height, [...context.getImageData(50, 20, 1, 1).data], [...context.getImageData(50, 80, 1, 1).data]];
    })).toEqual([100, 100, [0, 0, 255, 255], [255, 0, 0, 255]]);
});
test('an image left unchanged in the editor attaches as the original file', async ({ page }) => {
    await setup(page); await attachedFile(page);
    await page.evaluate(() => Lowcord.privacy.set({ coverAsk: true }));
    const buffer = Buffer.from(await whitePng(page));
    await page.getByLabel('Cover test').setInputFiles({ name: 'plain.png', mimeType: 'image/png', buffer });
    await page.getByRole('button', { name: 'Rotate left' }).click();
    await page.getByRole('button', { name: 'Rotate right' }).click();
    await page.getByRole('button', { name: 'Flip horizontally' }).click();
    await page.getByRole('button', { name: 'Flip horizontally' }).click();
    await page.getByRole('button', { name: 'Attach image' }).click();
    await expect.poll(() => page.evaluate(() => privacyFixture.attached?.size)).toBe(buffer.length);
});
test('videos lose their metadata on the way to the composer and report it', async ({ page }) => {
    await setup(page); await attachedFile(page);
    const body = text => Buffer.from(text);
    const box = (type, payload) => { const head = Buffer.alloc(8); head.writeUInt32BE(payload.length + 8); head.write(type, 4); return Buffer.concat([head, payload]); };
    const buffer = Buffer.concat([box('ftyp', body('isom0000')), box('moov', box('udta', body('GPS SECRET'))), box('mdat', body('VIDEO'))]);
    await page.getByLabel('Cover test').setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer });
    await expect.poll(() => page.evaluate(() => privacyFixture.attached?.name)).toBe('clip.mp4');
    const text = await page.evaluate(async () => new TextDecoder('latin1').decode(await privacyFixture.attached.arrayBuffer()));
    expect(text).not.toContain('GPS SECRET');
    expect(text).toContain('VIDEO');
    await expect(page.locator('.lowcord-toast')).toContainText('Metadata removed from 1 video.');
    expect(await page.evaluate(() => Lowcord.privacy.report.totals.videos)).toBe(1);
});
test('the privacy report counts protections, stays on reload and resets', async ({ page }) => {
    await setup(page);
    await page.evaluate(async () => {
        await fetch('/api/v9/science', { method: 'POST', body: '{}' }).catch(() => {});
        Lowcord.privacy.count('links', 3); Lowcord.privacy.report.flush();
    });
    const panel = await inlineSettings(page);
    await panel.getByRole('button', { name: 'View report' }).click();
    await expect(panel.locator('.lowcord-privacy-stats > div', { hasText: 'Link trackers' }).locator('dd')).toHaveText('3');
    await expect(panel.locator('.lowcord-privacy-total')).toContainText('protections');
    await page.reload(); await page.waitForFunction(() => window.fixtureReady);
    expect(await page.evaluate(() => Lowcord.privacy.report.totals.links)).toBe(3);
    await page.evaluate(() => { Lowcord.privacy.report.reset(); });
    expect(await page.evaluate(() => Lowcord.privacy.report.totals.links)).toBe(0);
});
test('each new protection pane stays inside the settings column', async ({ page }, info) => {
    await setup(page); const panel = await inlineSettings(page);
    await page.evaluate(() => {
        window.__LOWCORD_NATIVE__ = { ...window.__LOWCORD_NATIVE__, traces: async () => ({ clearOnQuit: true, signOut: false, cacheBytes: 1.2 * 1024 ** 3 }) };
        Lowcord.privacy.count('analytics', 13); Lowcord.privacy.count('links', 2); Lowcord.privacy.count('images', 1);
    });
    for (const name of ['Cover image details', 'Walk-away protection', 'Leave no trace', 'App lock']) {
        await panel.getByRole('button', { name: new RegExp(`^${name}`) }).click();
        await expect(panel.getByRole('button', { name: new RegExp(`^${name}`) })).toHaveAttribute('aria-expanded', 'true');
        if (name === 'Leave no trace') await expect(panel.getByText('1.2 GB')).toBeVisible();
        await page.screenshot({ path: info.outputPath(`${name}.png`) });
        const bounds = await panel.locator('.lowcord-settings-body').evaluate(node => ({ width: node.clientWidth, content: node.scrollWidth }));
        expect(bounds.content).toBeLessThanOrEqual(bounds.width + 1);
    }
});

test('the lock shortcut is recorded from a key press, rejects bare letters, resets and turns off', async ({ page }) => {
    await setup(page); const panel = await inlineSettings(page);
    await panel.getByRole('switch', { name: 'App lock' }).click();
    await panel.getByLabel('New passcode (4 digits)').fill('2468'); await panel.getByLabel('Confirm passcode').fill('2468');
    await panel.getByRole('button', { name: 'Turn on app lock' }).click();
    const keys = panel.getByRole('button', { name: /^Lock shortcut/ });
    const mod = await page.evaluate(() => /Mac/.test(navigator.platform)) ? 'Meta' : 'Control';
    await keys.click(); await expect(keys).toHaveText('Press keys…');
    await page.keyboard.press('KeyJ');
    await expect(panel.getByRole('alert')).toContainText('with a letter or number');
    await page.keyboard.press(`${mod}+Alt+KeyJ`);
    expect(await page.evaluate(() => Lowcord.privacy.state.lockShortcut)).toBe('Mod+Alt+J');
    await panel.getByRole('button', { name: 'Reset' }).click();
    expect(await page.evaluate(() => Lowcord.privacy.state.lockShortcut)).toBe('Mod+Shift+L');
    await keys.click(); await page.keyboard.press('Escape');
    expect(await page.evaluate(() => Lowcord.privacy.state.lockShortcut)).toBe('Mod+Shift+L');
    await keys.click(); await page.keyboard.press('Backspace');
    await expect(keys).toHaveText('Off');
    await page.reload(); expect(await page.evaluate(() => Lowcord.privacy.state.lockShortcut)).toBe('');
});

test('app lock sets a hashed passcode, covers the app, throttles guesses and needs the passcode to turn off', async ({ page }) => {
    await setup(page); const panel = await inlineSettings(page);
    await panel.getByRole('switch', { name: 'App lock' }).click();
    // A focused password field turns on macOS Secure Input; passcodes are masked text instead.
    await expect(panel.locator('input[type="password"]')).toHaveCount(0);
    await panel.getByLabel('New passcode (4 digits)').fill('2468'); await panel.getByLabel('Confirm passcode').fill('2468');
    await panel.getByRole('button', { name: 'Turn on app lock' }).click();
    await expect(panel.getByRole('switch', { name: 'App lock' })).toBeChecked();
    const stored = await page.evaluate(() => Lowcord.storage.getItem('lowcord.privacy.lock.v1'));
    expect(stored).not.toContain('2468'); expect(JSON.parse(stored).hash.length).toBeGreaterThan(20);
    await page.evaluate(() => Lowcord.privacy.walkAwayChanged('away'));
    const lock = page.getByRole('dialog', { name: 'OrbitCord is locked' }); await expect(lock).toBeVisible();
    await expect(lock.locator('input[type="password"]')).toHaveCount(0);
    await page.keyboard.press('Escape'); await expect(lock).toBeVisible();
    await lock.getByLabel('Passcode').fill('1111'); await page.keyboard.press('Enter');
    await expect(lock).toContainText('Wrong passcode');
    await lock.getByLabel('Passcode').fill('2468'); await page.keyboard.press('Enter');
    await expect(lock).toHaveCount(0);
    // Reload: covered again before Discord is usable.
    await page.reload(); await expect(page.getByRole('dialog', { name: 'OrbitCord is locked' })).toBeVisible();
    for (let i = 0; i < 5; i++) { await page.getByLabel('Passcode').fill('0000'); await page.keyboard.press('Enter'); await page.waitForTimeout(150); }
    await expect(page.locator('.lowcord-lock')).toContainText('Too many tries');
    await expect(page.getByLabel('Passcode')).toBeDisabled();
});

test('forgot passcode logs out through Discord and only then removes the lock', async ({ page }) => {
    await setup(page);
    await page.evaluate(async () => { await Lowcord.privacy.setPasscode('2468'); Lowcord.privacy.set({ appLock: true }); window.loggedOut = 0; Lowcord.privacy.lock(); });
    const lock = page.getByRole('dialog', { name: 'OrbitCord is locked' });
    await lock.getByRole('button', { name: 'Forgot passcode?' }).click();
    await expect(lock).toContainText('Log out of Discord to remove the lock');
    // No logout module: the lock stays.
    await lock.getByRole('button', { name: 'Log out' }).click();
    await expect(lock).toContainText('quit OrbitCord and try again');
    expect(await page.evaluate(() => Lowcord.privacy.state.appLock)).toBe(true);
    await page.evaluate(() => webpackChunkdiscord_app[0][2]({ c: { auth: { exports: { logout: () => { window.loggedOut++; } } } } }));
    await lock.getByRole('button', { name: 'Log out' }).click();
    await expect(lock).toHaveCount(0);
    expect(await page.evaluate(() => [window.loggedOut, Lowcord.privacy.state.appLock, Lowcord.storage.getItem('lowcord.privacy.lock.v1')])).toEqual([1, false, 'null']);
});

test('a lock that fires in the background waits for the window before asking for Touch ID', async ({ page }) => {
    await setup(page);
    await page.evaluate(async () => {
        window.touchCalls = 0; window.focused = false;
        window.__LOWCORD_NATIVE__ = { ...window.__LOWCORD_NATIVE__, touchIdAvailable: async () => true, touchId: async () => { window.touchCalls++; return { ok: false }; } };
        document.hasFocus = () => window.focused;
        await Lowcord.privacy.setPasscode('2468'); Lowcord.privacy.set({ appLock: true }); Lowcord.privacy.lock();
    });
    const lock = page.getByRole('dialog', { name: 'OrbitCord is locked' });
    await expect(lock.getByRole('button', { name: 'Unlock with Touch ID' })).toBeVisible();
    expect(await page.evaluate(() => window.touchCalls)).toBe(0);
    await page.evaluate(() => { window.focused = true; window.dispatchEvent(new Event('focus')); });
    await expect.poll(() => page.evaluate(() => window.touchCalls)).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.touchCalls)).toBe(1);
});

test('lock now covers the app without asking for Touch ID, and the keypad unlocks it', async ({ page }) => {
    await setup(page);
    expect(await page.evaluate(() => Lowcord.privacy.lockNow())).toBe(false);
    await page.evaluate(async () => {
        window.touchCalls = 0;
        window.__LOWCORD_NATIVE__ = { ...window.__LOWCORD_NATIVE__, touchIdAvailable: async () => true, touchId: async () => { window.touchCalls++; return { ok: false }; } };
        document.hasFocus = () => true;
        await Lowcord.privacy.setPasscode('2468'); Lowcord.privacy.set({ appLock: true });
    });
    expect(await page.evaluate(() => Lowcord.privacy.lockNow())).toBe(true);
    const lock = page.getByRole('dialog', { name: 'OrbitCord is locked' });
    await expect(lock.getByRole('button', { name: 'Unlock with Touch ID' })).toBeVisible();
    expect(await page.evaluate(() => window.touchCalls)).toBe(0);
    for (const digit of '246') await lock.getByRole('button', { name: digit, exact: true }).click();
    await expect(lock.locator('.lowcord-lock-dot.is-on')).toHaveCount(3);
    await expect(lock.locator('.lowcord-lock-dot')).toHaveCount(4);
    await lock.getByRole('button', { name: 'Delete' }).click();
    await expect(lock.getByLabel('Passcode')).toBeFocused();
    await page.screenshot({ path: 'test-results/lock-screen.png' });
    // The fourth digit unlocks without pressing Unlock.
    await page.keyboard.type('68');
    await expect(lock).toHaveCount(0);
});

test('passcodes are exactly 4 digits, and a longer one saved earlier still unlocks', async ({ page }) => {
    await setup(page);
    expect(await page.evaluate(() => Lowcord.privacy.setPasscode('24680').then(() => 'saved', error => error.message))).toBe('Use exactly 4 digits.');
    expect(await page.evaluate(() => Lowcord.privacy.setPasscode('246').then(() => 'saved', error => error.message))).toBe('Use exactly 4 digits.');
    // An older 6-digit passcode, saved before the 4-digit rule.
    await page.evaluate(async () => {
        await Lowcord.privacy.setPasscode('2468');
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const material = await crypto.subtle.importKey('raw', new TextEncoder().encode('135790'), 'PBKDF2', false, ['deriveBits']);
        const hash = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 150000 }, material, 256));
        const text = bytes => btoa(String.fromCharCode(...bytes));
        Lowcord.storage.setItem('lowcord.privacy.lock.v1', JSON.stringify({ v: 1, salt: text(salt), hash: text(hash) }));
        Lowcord.privacy.set({ appLock: true });
    });
    await page.reload(); await page.waitForFunction(() => window.fixtureReady);
    const lock = page.getByRole('dialog', { name: 'OrbitCord is locked' });
    await lock.getByLabel('Passcode').fill('135790');
    await lock.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(lock).toHaveCount(0);
});

test('saved app lock waits for the document root without aborting settings or losing preferences', async ({ page }) => {
    const { pbkdf2Sync } = require('node:crypto');
    const salt = Buffer.alloc(16, 7);
    const savedCode = { v: 1, salt: salt.toString('base64'), hash: pbkdf2Sync('2468', salt, 150000, 32, 'sha256').toString('base64') };
    const preferences = { appLock: true, metadata: false, inspector: true, lockAfter: 5 };
    await page.addInitScript(({ preferences, savedCode }) => {
        localStorage.setItem('lowcord.privacy.v1', JSON.stringify(preferences));
        localStorage.setItem('lowcord.privacy.lock.v1', JSON.stringify(savedCode));
        localStorage.setItem('lowcord.extensions', JSON.stringify({ silentTyping: false }));
    }, { preferences, savedCode });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const source = readFileSync('src-tauri/injection/privacy.js', 'utf8');
    await page.route('**/injection/privacy.js', route => route.fulfill({ contentType: 'text/javascript', body: `
        // Electron may run the preload before Chromium has created <html>.
        Object.defineProperty(document, 'documentElement', { configurable: true, value: null });
        try { ${source}\nwindow.privacyReadyBeforeRoot = !!window.Lowcord.privacy; }
        finally { delete document.documentElement; document.appendChild(document.createComment('root-ready')); }
    ` }));
    await page.goto('/extensions');
    await page.waitForFunction(() => window.fixtureReady);
    expect(await page.evaluate(() => window.privacyReadyBeforeRoot)).toBe(true);
    const lock = page.getByRole('dialog', { name: 'OrbitCord is locked' });
    await expect(lock).toBeVisible();
    expect(await page.evaluate(() => document.body.inert)).toBe(true);
    expect(await page.evaluate(() => Lowcord.storage.getItem('lowcord.privacy.lock.v1'))).toBe(JSON.stringify(savedCode));
    expect(await page.evaluate(() => Lowcord.privacy.state.metadata)).toBe(false);
    expect(await page.evaluate(() => Lowcord.extensions.enabled('silentTyping'))).toBe(false);
    await lock.getByLabel('Passcode').fill('2468');
    await lock.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(lock).toHaveCount(0);
    expect(await page.evaluate(() => document.body.inert)).toBe(false);
    await page.evaluate(() => window.__lowcordOpenSettings('extensions'));
    await expect(page.getByRole('searchbox', { name: 'Search extensions' })).toBeVisible();
    expect(errors).toEqual([]);
});
