import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.goto('/uploads');
    await page.addScriptTag({ url: '/injection/discord.js' });
    await page.addStyleTag({ url: '/injection/video-compression.css' });
    await page.evaluate(async () => {
        window.Lowcord.storage = localStorage;
        const wrap = document.createElement('form');
        wrap.className = 'channelTextArea_test';
        document.body.append(wrap);
        for (const id of ['files', 'drop']) wrap.append(document.querySelector(`#${id}`));
        const editor = document.createElement('textarea'); editor.setAttribute('aria-label', 'Message'); editor.value = 'Keep this draft'; wrap.append(editor);
        window.fixtureChannel = { id: 'dm', type: 1 };
        const listeners = new Set();
        window.switchChat = channel => { window.fixtureChannel = channel; for (const fn of listeners) fn(); };
        window.Lowcord.store = name => ({
            SelectedChannelStore: { getChannelId: () => window.fixtureChannel.id, addChangeListener: fn => listeners.add(fn), removeChangeListener: fn => listeners.delete(fn) },
            ChannelStore: { getChannel: id => window.fixtureChannel.id === id ? window.fixtureChannel : null },
        })[name];
        window.calls = []; window.jobs = new Map(); window.failure = null; window.hold = false;
        const sample = new Uint8Array(await (await fetch('/media/sample.mp4')).arrayBuffer());
        window.__LOWCORD_NATIVE__ = { videoCompression: async (action, ...args) => {
            window.calls.push({ action, options: action === 'begin' ? args[0] : undefined, length: action === 'append' ? args[1].length : undefined });
            if (action === 'begin') { const id = `job-${window.calls.length}`; window.jobs.set(id, { ...args[0], written: 0 }); return { id }; }
            const job = window.jobs.get(args[0]);
            if (action === 'cancel') { job.cancelled = true; window.release?.(); return; }
            if (action === 'append') { job.written += args[1].length; return; }
            if (action === 'finish') {
                if (window.hold) await new Promise(resolve => { window.release = resolve; });
                if (job.cancelled) return { error: 'cancelled' };
                if (window.failure) return { error: window.failure };
                if (job.written !== job.size) throw Error('Incomplete source');
                return { size: sample.length };
            }
            if (action === 'read') return sample.slice(args[1], args[1] + 1024 * 1024);
        }};
        window.fixturePaste = event => { if (event.clipboardData.files.length) window.fixtureAdd([event.clipboardData.files[0]]); };
        editor.addEventListener('paste', window.fixturePaste);
        window.sentFromKeyboard = 0;
        editor.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) window.sentFromKeyboard++; });
    });
    await page.addScriptTag({ url: '/social-links.js' });
    await page.addScriptTag({ url: '/music-links.js' });
    await page.addScriptTag({ url: '/injection/video-compression.js' });
    await page.addScriptTag({ url: '/injection/extensions.js' });
    await page.addScriptTag({ url: '/injection/background.js' });
    await page.evaluate(() => Lowcord.extensions.set('anonymiseFileNames', false));
});

async function select(page, { size = 20_000_001, name = 'SPOILER_walk.mov', type = 'video/quicktime', method = 'change', mixed = false } = {}) {
    await page.evaluate(({ size, name, type, method, mixed }) => {
        const data = new DataTransfer();
        if (mixed) data.items.add(new File(['original picture'], 'photo.png', { type: 'image/png' }));
        data.items.add(new File([new Uint8Array(size)], name, { type, lastModified: 123456 }));
        if (mixed) data.items.add(new File(['original document'], 'notes.txt', { type: 'text/plain' }));
        if (method === 'change') { const input = document.querySelector('#files'); input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true })); }
        if (method === 'drop') document.querySelector('#drop').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
        if (method === 'paste') document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    }, { size, name, type, method, mixed });
}
async function ready(page, count = 1) {
    await expect.poll(() => page.evaluate(() => window.Lowcord.videoCompression.busy())).toBe(false);
    await expect(page.locator('#drafts article')).toHaveCount(count);
}

test('DM chooser compresses under 20 MB before metadata; preserves spoiler name, draft and native Send', async ({ page }) => {
    await select(page); await ready(page);
    await expect(page.locator('#drafts article span')).toHaveText('SPOILER_walk.mp4');
    expect(await page.evaluate(() => ({ begin: calls.find(c => c.action === 'begin').options,
        maximum: Math.max(...calls.filter(c => c.action === 'append').map(c => c.length)),
        size: prepared[0].file.size, metadata: prepared[0].compressionMetadata, modified: prepared[0].file.lastModified })))
        .toMatchObject({ begin: { size: 20_000_001, limit: 20_000_000 }, maximum: 1024 * 1024,
            metadata: { originalContentType: 'video/mp4' }, modified: 123456 });
    await expect(page.getByLabel('Message')).toHaveValue('Keep this draft');
    expect(await page.evaluate(() => prepared[0].compressionMetadata.preCompressionSize)).toBe(await page.evaluate(() => prepared[0].file.size));
    expect(await page.evaluate(() => receipts.length)).toBe(0);
    await page.getByRole('button', { name: 'Send test upload' }).click();
    await expect(page.locator('#state')).toHaveText('Sent');
    expect(await page.evaluate(() => receipts[0].size)).toBeLessThan(20_000_000);
});

test('server threads use 100 MB; smaller video stays unchanged and a boundary-size video is compressed', async ({ page }) => {
    await page.evaluate(() => switchChat({ id: 'thread', guild_id: 'guild', type: 11 }));
    await select(page, { size: 20_000_001, name: 'small.mp4', type: 'video/mp4' }); await ready(page);
    expect(await page.evaluate(() => calls.length)).toBe(0);
    expect(await page.evaluate(() => prepared[0].file.size)).toBe(20_000_001);
    await select(page, { size: 100_000_000 }); await ready(page, 2);
    expect(await page.evaluate(() => calls.find(c => c.action === 'begin').options.limit)).toBe(100_000_000);
});

test('group DM drop retains mixed batch order and nonvideo bytes; anonymization still runs once', async ({ page }) => {
    await page.evaluate(() => { switchChat({ id: 'group', type: 3 }); Lowcord.extensions.set('anonymiseFileNames', true); });
    await select(page, { method: 'drop', mixed: true }); await ready(page, 3);
    const result = await page.evaluate(async () => ({ files: await Promise.all(prepared.map(async ({file}) => ({ name: file.name, type: file.type,
        text: file.type.startsWith('video/') ? null : await file.text() }))), starts: calls.filter(c => c.action === 'begin').length }));
    expect(result.starts).toBe(1);
    expect(result.files.map(f => f.type)).toEqual(['image/png','video/mp4','text/plain']);
    expect(result.files.map(f => f.text)).toEqual(['original picture',null,'original document']);
    expect(result.files[1].name).toMatch(/^SPOILER_[a-z]{7}\.mp4$/);
});

test('Discord upload overlay outside main compresses before native size validation and keeps small drops native', async ({ page }) => {
    await page.evaluate(() => {
        // Production uploadArea is a sibling of main, rather than its child.
        const main = document.createElement('main');
        const chat = document.createElement('div'); chat.className = 'chat_fixture';
        document.body.append(chat); chat.append(main); main.append(document.querySelector('.channelTextArea_test'));
        const overlay = document.createElement('div'); overlay.className = 'uploadArea_fixture';
        overlay.dataset.dragging = 'true';
        const inner = document.createElement('span'); inner.id = 'overlay-drop'; overlay.append(inner); chat.append(overlay);
        window.nativeDropWarnings = 0; window.nativeDropCleanups = 0;
        document.body.addEventListener('drop', event => {
            if (!event.dataTransfer.files.length) { window.nativeDropCleanups++; overlay.dataset.dragging = 'false'; }
        });
        overlay.addEventListener('drop', event => {
            event.preventDefault();
            if (overlay.dataset.dragging !== 'true') return;
            const files = [...event.dataTransfer.files];
            if (files.some(file => file.size >= 20_000_000)) { window.nativeDropWarnings++; return; }
            window.fixtureAdd(files);
        });
    });
    const drop = async size => page.evaluate(size => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(size)], 'overlay.mov', { type: 'video/quicktime' }));
        document.querySelector('#overlay-drop').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    }, size);
    await drop(20_000_001);
    await ready(page);
    expect(await page.evaluate(() => window.nativeDropWarnings)).toBe(0);
    expect(await page.evaluate(() => window.nativeDropCleanups)).toBe(1);
    expect(await page.evaluate(() => calls.filter(c => c.action === 'begin').length)).toBe(1);
    await expect(page.locator('#drafts article span')).toHaveText('overlay.mp4');
    await page.evaluate(() => { document.querySelector('.uploadArea_fixture').dataset.dragging = 'true'; });
    await drop(100); await ready(page, 2);
    expect(await page.evaluate(() => prepared[1].file.size)).toBe(100);
    await page.evaluate(() => Lowcord.extensions.set('compressVideos', false));
    await drop(20_000_001);
    expect(await page.evaluate(() => window.nativeDropWarnings)).toBe(1);
});

test('pasted videos compress and attach without sending; small videos and documents keep original bytes', async ({ page }) => {
    await select(page, { method: 'paste', mixed: true }); await ready(page, 3);
    expect(await page.evaluate(() => prepared.map(entry => entry.file.name))).toEqual(['photo.png','SPOILER_walk.mp4','notes.txt']);
    await select(page, { method: 'drop', size: 20, name: 'small.webm', type: 'video/webm' }); await ready(page, 4);
    await select(page, { method: 'change', size: 20_000_001, name: 'notes.bin', type: 'application/octet-stream' }); await ready(page, 5);
    expect(await page.evaluate(() => calls.filter(c => c.action === 'begin').length)).toBe(1);
    expect(await page.evaluate(() => prepared.slice(3).map(entry => entry.file.size))).toEqual([20,20_000_001]);
});

test('compression failure restores all original files once and explains missing FFmpeg', async ({ page }) => {
    await page.evaluate(() => { window.failure = 'ffmpeg-missing'; Lowcord.extensions.set('anonymiseFileNames', true); });
    await select(page, { method: 'drop', mixed: true }); await ready(page, 3);
    expect(await page.evaluate(() => prepared.map(entry => entry.file.type))).toEqual(['image/png','video/quicktime','text/plain']);
    expect(await page.evaluate(() => prepared[1].file.size)).toBe(20_000_001);
    expect(await page.evaluate(() => calls.filter(c => c.action === 'begin').length)).toBe(1);
    await expect(page.locator('.lowcord-toast[role="status"]')).toContainText('Install FFmpeg');
});

test('Cancel stops native work; Enter cannot send a partial draft during compression', async ({ page }) => {
    await page.evaluate(() => { window.hold = true; });
    await select(page);
    await expect.poll(() => page.evaluate(() => calls.some(c => c.action === 'finish'))).toBe(true);
    expect(await page.evaluate(() => __lowcordBusy())).toBe(true);
    await page.getByLabel('Message').press('Enter');
    expect(await page.evaluate(() => sentFromKeyboard)).toBe(0);
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    await page.evaluate(() => Lowcord.extensions.set('compressVideos', false));
    await expect.poll(() => page.evaluate(() => Lowcord.videoCompression.busy())).toBe(false);
    expect(await page.evaluate(() => __lowcordBusy())).toBe(false);
    await expect(page.locator('#drafts article')).toHaveCount(0);
    await expect(page.getByLabel('Message')).toHaveValue('Keep this draft');
    await page.evaluate(() => { Lowcord.extensions.set('compressVideos', true); window.hold = true; });
    await select(page);
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect.poll(() => page.evaluate(() => Lowcord.videoCompression.busy())).toBe(false);
    await expect(page.locator('#drafts article')).toHaveCount(0);
});

test('two large videos run sequentially and remain in their original attachment order', async ({ page }) => {
    await page.evaluate(() => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(20_000_001)], 'first.webm', { type: 'video/webm' }));
        data.items.add(new File([new Uint8Array(20_000_002)], 'second.mov', { type: 'video/quicktime' }));
        const input = document.querySelector('#files'); input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await ready(page, 2);
    await expect(page.locator('#drafts article span')).toHaveText(['first.mp4','second.mp4']);
    expect(await page.evaluate(() => calls.filter(c => c.action !== 'append').map(c => c.action)))
        .toEqual(['begin','finish','read','cancel','begin','finish','read','cancel']);
    expect(await page.evaluate(() => receipts.length)).toBe(0);
});

test('switching chats cancels work; disabling passes future files to native preparation untouched', async ({ page }) => {
    await page.evaluate(() => { window.hold = true; });
    await select(page);
    await expect.poll(() => page.evaluate(() => calls.some(c => c.action === 'finish'))).toBe(true);
    await page.evaluate(() => switchChat({ id: 'different', guild_id: 'server' }));
    await expect.poll(() => page.evaluate(() => Lowcord.videoCompression.busy())).toBe(false);
    await expect(page.locator('#drafts article')).toHaveCount(0);
    await page.evaluate(() => Lowcord.extensions.set('compressVideos', false));
    await select(page); await ready(page);
    expect(await page.evaluate(() => prepared[0].file.size)).toBe(20_000_001);
});

test('settings file inputs are outside compression scope and pending status provides Cancel', async ({ page }) => {
    await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'settings-file'; document.body.append(input); });
    await page.locator('#settings-file').setInputFiles({ name: 'large.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(20_000_001) });
    expect(await page.evaluate(() => calls.length)).toBe(0);
    await page.addStyleTag({ content: '.channelTextArea_test {position:fixed;left:16px;right:16px;bottom:16px;height:56px;background:#2b2d31;border-radius:12px} .channelTextArea_test #files,.channelTextArea_test #drop {display:none} .channelTextArea_test textarea {box-sizing:border-box;margin:0;padding:16px;width:100%;height:56px;border:0;background:transparent;color:white;resize:none;font:14px system-ui}' });
    await page.evaluate(() => { window.hold = true; });
    await select(page);
    await expect.poll(() => page.evaluate(() => calls.some(c => c.action === 'finish'))).toBe(true);
    await expect(page.locator('.lowcord-video-compression[role="status"]')).toContainText('20 MB');
    await expect(page.locator('.lowcord-video-compression strong')).toHaveText('Compressing 1 video');
    await expect(page.locator('.lowcord-video-compression span')).toHaveText('MP4 · under 20 MB');
    await expect(page.locator('.lowcord-video-compression')).toHaveAttribute('title', 'SPOILER_walk.mov');
    const toast = await page.locator('.lowcord-video-compression').boundingBox();
    const composer = await page.locator('.channelTextArea_test').boundingBox();
    expect(toast.height).toBeLessThanOrEqual(64);
    expect(Math.abs(toast.x + toast.width / 2 - composer.x - composer.width / 2)).toBeLessThanOrEqual(1);
    expect(composer.y - toast.y - toast.height).toBe(16);
    await page.screenshot({ path: '/tmp/lowcord-video-compression.png' });
    await page.setViewportSize({ width: 360, height: 520 });
    const bounds = await page.locator('.lowcord-video-compression').boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(16); expect(bounds.x + bounds.width).toBeLessThanOrEqual(344);
    await page.screenshot({ path: '/tmp/lowcord-video-compression-narrow.png' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await page.locator('.lowcord-compression-ring').evaluate(node => getComputedStyle(node).animationName)).toBe('none');
    await page.locator('.channelTextArea_test').evaluate(node => { node.style.height = '120px'; });
    await expect.poll(async () => {
        const card = await page.locator('.lowcord-video-compression').boundingBox();
        const box = await page.locator('.channelTextArea_test').boundingBox();
        return Math.round(box.y - card.y - card.height);
    }).toBe(16);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('selected bottom toast matches the compact reference at desktop and stays within an off-center chat pane', async ({ page }) => {
    await page.setViewportSize({ width: 1536, height: 1024 });
    await page.addStyleTag({ content: `
        body { margin:0;padding:0;background:#1b1c20;color:#f2f3f5;font:16px system-ui; }
        body > h1, body > label, body > button, body > output, #results, #drafts { display:none; }
        .channelTextArea_test { position:fixed;left:470px;right:32px;bottom:48px;height:72px;margin:0;background:#27282d;border:1px solid #ffffff12;border-radius:16px; }
        .channelTextArea_test #files,.channelTextArea_test #drop {display:none}
        .channelTextArea_test textarea {box-sizing:border-box;width:100%;height:100%;padding:24px;margin:0;background:transparent;border:0;resize:none;font:16px system-ui;color:#b5bac1;}
        .visual-sidebar {position:fixed;left:0;top:0;bottom:0;width:436px;background:#17181c;border-right:1px solid #ffffff08;padding:32px;box-sizing:border-box;}
        .visual-conversation {margin-left:470px;padding:36px 32px 0 0;}
        .visual-conversation h2 {margin:0 0 48px;font-size:20px;}
        .visual-conversation p {margin:0 0 48px;line-height:1.6;}
        .visual-conversation strong {display:block;font-size:15px;margin-bottom:4px;}
    ` });
    await page.evaluate(() => {
        const sidebar = document.createElement('aside'); sidebar.className = 'visual-sidebar'; sidebar.textContent = 'Direct Messages';
        const conversation = document.createElement('section'); conversation.className = 'visual-conversation';
        const heading = document.createElement('h2'); heading.textContent = 'Alex'; conversation.append(heading);
        for (const [name,text] of [['Alex','That hike last weekend was incredible.'],['You','Agreed, such a good day.'],['Alex','We should definitely do another one soon.']]) {
            const row = document.createElement('p'); const label = document.createElement('strong'); label.textContent = name; row.append(label,text); conversation.append(row);
        }
        document.body.append(sidebar,conversation);
        document.querySelector('textarea').value = 'Message Alex'; window.hold = true;
    });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await select(page);
    await expect.poll(() => page.evaluate(() => calls.some(c => c.action === 'finish'))).toBe(true);
    await page.screenshot({ path: '/tmp/lowcord-compression-option-one.png' });
    await page.locator('.lowcord-video-compression').screenshot({ path: '/tmp/lowcord-compression-option-one-toast.png' });
    const box = await page.locator('.lowcord-video-compression').boundingBox();
    expect(box.y).toBeGreaterThan(800); expect(box.width).toBe(360);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect.poll(() => page.evaluate(() => Lowcord.videoCompression.busy())).toBe(false);
    await expect(page.locator('.lowcord-video-compression')).toHaveCount(0);
    expect(errors).toEqual([]);
});
