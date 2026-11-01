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
        webpackChunkdiscord_app[0][2]({ c: { privacy: { exports: { ...stores, dispatcher } } } });
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
    await expect(panel.getByRole('navigation', { name: 'Protections' }).getByRole('button')).toHaveText([/^Media metadata/, /^Cover image details/, /^Message expiry/, /^Attachment inspector/, /^Walk-away protection/, /^Leave no trace/, /^Privacy report/]);
    await expect(panel.getByRole('switch', { name: 'Remove media metadata' })).toBeChecked();
    await expect(page.locator('.contentHeader_test button')).toBeVisible();
    await expect(page.locator('.lowcord-settings-backdrop')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('privacy-settings.png') });
    await panel.getByRole('navigation', { name: 'Protections' }).getByRole('button', { name: /^Attachment inspector/ }).click();
    await panel.getByRole('switch', { name: 'Attachment inspector' }).click();
    await page.reload(); await page.waitForFunction(() => window.fixtureReady);
    expect(await page.evaluate(() => Lowcord.privacy.state)).toEqual({ metadata: true, inspector: false, walkAway: true, coverAsk: false });
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
test('asking before attaching covers pixels permanently and cancelling attaches nothing', async ({ page }, info) => {
    await setup(page); await attachedFile(page);
    await page.evaluate(() => Lowcord.privacy.set({ coverAsk: true }));
    const buffer = Buffer.from(await whitePng(page));
    await page.getByLabel('Cover test').setInputFiles({ name: 'address.png', mimeType: 'image/png', buffer });
    const canvas = page.locator('.lowcord-cover-stage canvas');
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
    await panel.getByRole('button', { name: /^Privacy report/ }).click();
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
    for (const name of ['Cover image details', 'Walk-away protection', 'Leave no trace', 'Privacy report']) {
        await panel.getByRole('button', { name: new RegExp(`^${name}`) }).click();
        await expect(panel.locator('#lowcord-privacy-detail-title')).toHaveText(name);
        if (name === 'Leave no trace') await expect(panel.getByText('1.2 GB')).toBeVisible();
        await page.screenshot({ path: info.outputPath(`${name}.png`) });
        const bounds = await panel.locator('.lowcord-settings-body').evaluate(node => ({ width: node.clientWidth, content: node.scrollWidth }));
        expect(bounds.content).toBeLessThanOrEqual(bounds.width + 1);
    }
});
