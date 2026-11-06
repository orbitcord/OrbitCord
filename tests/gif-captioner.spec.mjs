import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.goto('/extensions');
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
    await page.addScriptTag({ url: '/injection/gif-captioner.js' });
    await page.addStyleTag({ url: '/injection/gif-captioner.css' });
    await page.addStyleTag({ url: '/injection/lowcord-ui.css' });
});

test('wraps and sizes caption text to the width', async ({ page }) => {
    const result = await page.evaluate(() => {
        const { wrap, fit } = Lowcord.gifCaptioner;
        const measure = text => text.length * 10;
        const short = fit(font => measure, 'hi', 400, 'bar');
        const long = fit(font => text => text.length * parseInt(font.match(/(\d+)px/)[1]) * .5, 'when the caption is really long and keeps going on and on and on until it needs a smaller font to fit', 300, 'bar');
        return { lines: wrap(measure, 'one two three four', 90), split: wrap(measure, 'abcdefghijkl', 50), breaks: wrap(measure, 'a\n\nb', 100),
            empty: fit(font => measure, '   ', 300, 'bar').height, short, long };
    });
    expect(result.lines).toEqual(['one two', 'three', 'four']);
    expect(result.split).toEqual(['abcde', 'fghij', 'kl']);
    expect(result.breaks).toEqual(['a', '', 'b']);
    expect(result.empty).toBe(0);
    expect(result.short.lines).toEqual(['hi']);
    expect(result.long.lines.length).toBeLessThanOrEqual(5);
    expect(result.long.size).toBeLessThan(33);
    expect(result.long.height).toBe(result.long.lines.length * result.long.lineHeight + result.long.pad * 2);
});

test('meme and subtitle text fit over the video without adding a bar', async ({ page }) => {
    const result = await page.evaluate(() => {
        const { memeLayout, subtitleLayout, fitBlock, caption } = Lowcord.gifCaptioner;
        const measureWith = font => text => text.length * parseInt(font.match(/(\d+)px/)[1]) * .6;
        const long = 'this is a very long line of text that keeps going and going well past three lines at any size we would pick';
        const meme = memeLayout(measureWith, { top: 'one does not simply', bottom: long }, 300, 200);
        const sub = subtitleLayout(measureWith, long, 300, 200);
        const cut = fitBlock(measureWith, long, 100, { font: px => `${px}px x`, max: 12, maxLines: 2 });
        return { meme, sub, cut, memeBox: caption({ top: 'a', bottom: 'b' }, 'meme').layout(200, 150), subBox: caption('a', 'subtitle').layout(200, 150) };
    });
    expect(result.meme.top.lines.join(' ')).toBe('ONE DOES NOT SIMPLY');
    expect(result.meme.top.size).toBeLessThanOrEqual(Math.round(300 * .13));
    expect(result.meme.bottom.lines.length).toBeLessThanOrEqual(3);
    expect(result.meme.bottom.lines.every(line => line === line.toUpperCase())).toBe(true);
    expect(result.meme.bottom.size).toBeGreaterThanOrEqual(10);
    expect(result.sub.block.lines.length).toBeLessThanOrEqual(3);
    expect(result.sub.block.size).toBeLessThanOrEqual(Math.round(300 * .07));
    expect(result.cut.lines.length).toBe(2);
    expect(result.cut.lines[1].endsWith('…')).toBe(true);
    expect(result.memeBox).toEqual({ width: 200, height: 150, x: 0, y: 0, w: 200, h: 150 });
    expect(result.subBox).toEqual({ width: 200, height: 150, x: 0, y: 0, w: 200, h: 150 });
});

for (const style of ['bar', 'meme', 'subtitle', 'bubble']) {
    test(`${style} overlay draws on an untainted canvas and encodes a GIF`, async ({ page }) => {
        const result = await page.evaluate(async style => {
            const bytes = new Uint8Array(await (await fetch('/media/sample.mp4')).arrayBuffer());
            const text = style === 'meme' ? { top: 'Top text', bottom: 'Bottom text' } : 'Top text goes here';
            const made = Lowcord.gifCaptioner.caption(text, style, { x: .5, y: .6 });
            const canvas = document.createElement('canvas');
            Object.assign(canvas, { width: 200, height: 160 });
            const context = canvas.getContext('2d', { willReadFrequently: true });
            context.fillStyle = '#fff'; context.fillRect(0, 0, 200, 160);
            made.drawOverlay(context, 200, 160);
            let tainted = false, dark = 0;
            try { const data = context.getImageData(0, 0, 200, 160).data; for (let i = 0; i < data.length; i += 4) if (data[i] < 100) dark++; } catch { tainted = true; }
            const fractions = [];
            const gif = await Lowcord.gif.encode({ bytes, limit: 32 * 1024 * 1024, layout: made.layout, drawOverlay: made.drawOverlay, progress: value => fractions.push(value) });
            const view = new DataView(gif.buffer);
            return { tainted, dark, head: String.fromCharCode(...gif.slice(0, 6)), width: view.getUint16(6, true), height: view.getUint16(8, true), progressed: fractions.length > 0 };
        }, style);
        expect(result.tainted).toBe(false);
        expect(result.dark).toBeGreaterThan(20);
        expect(result.head).toBe('GIF89a');
        expect(result.height).toBeGreaterThan(1);
        expect(result.progressed).toBe(true);
    });
}

test('encode converts only the trimmed range', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const bytes = new Uint8Array(await (await fetch('/media/sample.mp4')).arrayBuffer());
        const made = Lowcord.gifCaptioner.caption('trim', 'bar');
        const run = async range => {
            const frames = [];
            const gif = await Lowcord.gif.encode({ bytes, limit: 32 * 1024 * 1024, layout: made.layout, drawOverlay: made.drawOverlay, progress: value => frames.push(value), ...range });
            return { frames: frames.length, size: gif.length };
        };
        return { full: await run({}), trimmed: await run({ start: .5, end: 1 }), trim: Lowcord.gifCaptioner.trimText(.4, 2.1, 3.7) };
    });
    expect(result.full.frames).toBe(30);
    expect(result.trimmed.frames).toBeLessThan(10);
    expect(result.trimmed.size).toBeLessThan(result.full.size);
    expect(result.trim).toBe('Trim · 0.4s – 2.1s of 3.7s');
});

test('Tenor GIF URLs map to their MP4 rendition', async ({ page }) => {
    const mapped = await page.evaluate(() => [
        'https://media.tenor.com/slf4mspyGvYAAAAM/cat-catnopers.gif',
        'https://media.tenor.com/slf4mspyGvYAAAAC/cat-catnopers.gif',
        'https://static.klipy.com/ii/abc/AauS3Atn5cFLGjR0wm.webp',
        'https://media.tenor.com/slf4mspyGvYAAAPo/cat-catnopers.mp4',
    ].map(Lowcord.gifCaptioner.tenorMp4));
    expect(mapped).toEqual([
        'https://media.tenor.com/slf4mspyGvYAAAPo/cat-catnopers.mp4',
        'https://media.tenor.com/slf4mspyGvYAAAPo/cat-catnopers.mp4',
        '', '',
    ]);
});

test('an animated GIF is captioned frame by frame', async ({ page }) => {
    const result = await page.evaluate(async () => {
        // A plain animated GIF made from the sample clip, then captioned.
        const video = new Uint8Array(await (await fetch('/media/sample.mp4')).arrayBuffer());
        const source = await Lowcord.gif.encode({ bytes: video, limit: 32 * 1024 * 1024, start: 0, end: .3,
            layout: (w, h) => ({ width: w, height: h, x: 0, y: 0, w, h }), drawOverlay: () => {} });
        const frames = async bytes => {
            const decoder = new ImageDecoder({ data: bytes, type: 'image/gif' });
            await decoder.tracks.ready; await decoder.completed;
            const count = decoder.tracks.selectedTrack.frameCount;
            const { image } = await decoder.decode({ frameIndex: 0 });
            const canvas = new OffscreenCanvas(image.displayWidth, image.displayHeight), context = canvas.getContext('2d');
            context.drawImage(image, 0, 0);
            image.close(); decoder.close();
            return { count, context, width: canvas.width, height: canvas.height };
        };
        const before = await frames(source);
        const made = Lowcord.gifCaptioner.caption('Top text goes here', 'bar');
        const gif = await Lowcord.gif.encode({ bytes: source, limit: 32 * 1024 * 1024, layout: made.layout, drawOverlay: made.drawOverlay });
        const after = await frames(gif);
        // The bar sits above the clip: white with dark text.
        const bar = after.context.getImageData(0, 0, after.width, after.height - before.height).data;
        let white = 0, dark = 0;
        for (let i = 0; i < bar.length; i += 4) { if (bar[i] > 230 && bar[i + 1] > 230 && bar[i + 2] > 230) white++; else if (bar[i] < 100) dark++; }
        const adapter = await Lowcord.gif.animated(source);
        const info = { duration: adapter.duration, width: adapter.videoWidth, framed: adapter.frame instanceof VideoFrame };
        adapter.close();
        return { head: String.fromCharCode(...gif.slice(0, 6)), before: { count: before.count, width: before.width, height: before.height },
            after: { count: after.count, width: after.width, height: after.height }, white, dark, info, none: await Lowcord.gif.animated(video) };
    });
    expect(result.head).toBe('GIF89a');
    expect(result.before.count).toBeGreaterThan(1);
    expect(result.after.count).toBeGreaterThan(1);
    expect(result.after.width).toBe(result.before.width);
    expect(result.after.height).toBeGreaterThan(result.before.height);
    expect(result.white).toBeGreaterThan(100);
    expect(result.dark).toBeGreaterThan(20);
    expect(result.info).toEqual({ duration: expect.closeTo(.3, 1), width: result.before.width, framed: true });
    expect(result.none).toBeNull();
});

// Discord's uploader, REST client and stores, as the captioner uses them.
async function mockDiscord(page) {
    await page.evaluate(() => {
        const fixture = window.capFixture = { uploads: [], posts: [], attached: [], replies: [] };
        const store = Lowcord.store;
        const message = { id: '200', channel_id: '100', author: { username: 'pat' }, attachments: [],
            embeds: [{ type: 'gifv', url: 'https://tenor.com/view/x', video: { url: '/media/sample.mp4', proxyURL: '/media/sample.mp4' } }] };
        Lowcord.store = name => ({
            SelectedChannelStore: { getChannelId: () => '100' },
            ChannelStore: { getChannel: id => ({ id, guild_id: '300' }) },
            MessageStore: { getMessage: (channel, id) => channel === '100' && id === '200' ? message : null },
        })[name] || store(name);
        Object.defineProperty(Lowcord, 'Dispatcher', { configurable: true, value: { dispatch: action => {
            if (action.type === 'CREATE_PENDING_REPLY') fixture.replies.push({ message: action.message.id, channel: action.channel.id, shouldMention: action.shouldMention });
        } } });
        Object.defineProperty(Lowcord, 'CloudUpload', { configurable: true, value: class {
            constructor({ file }, channel) { this.file = file; this.channel = channel; this.handlers = {}; this.filename = file.name; this.uploadedFilename = `up/${file.name}`; }
            on(type, fn) { this.handlers[type] = fn; }
            async upload() { fixture.uploads.push({ name: this.file.name, type: this.file.type, channel: this.channel }); this.handlers.progress?.(.5); this.handlers.complete(); }
        } });
        Object.defineProperty(Lowcord, 'RestAPI', { configurable: true, value: { post: async request => { fixture.posts.push(request); return { body: {} }; } } });
        Lowcord.privacy.attach = files => { fixture.attached.push(...files.map(file => file.name)); return true; };
    });
}
async function addPickerResult(page) {
    await page.evaluate(() => document.querySelector('main').insertAdjacentHTML('beforeend',
        '<div id="gif-picker-tab-panel"><div class="result_test" role="button" style="width:240px;height:160px"><video src="/media/sample.mp4" muted loop autoplay></video></div></div>'));
    const result = page.locator('#gif-picker-tab-panel [class*="result_"]').first();
    await result.hover();
    await result.locator('.lowcord-gifcap-btn').click();
    const dialog = page.getByRole('dialog', { name: 'Caption GIF' });
    await expect(dialog).toBeVisible();
    return { dialog, result };
}

test('picker dialog: styles, trim, Enter sends and Shift+Enter adds to the message', async ({ page }) => {
    await mockDiscord(page);
    const { dialog, result } = await addPickerResult(page);
    const send = dialog.getByRole('button', { name: 'Send' });
    await expect(send).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Add to message' })).toBeDisabled();
    for (const name of ['Bar', 'Meme', 'Subtitle', 'Bubble']) await expect(dialog.getByRole('button', { name, exact: true })).toBeVisible();

    await dialog.getByRole('button', { name: 'Meme', exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: 'Top text' })).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Caption' })).toHaveCount(0);
    await dialog.getByRole('textbox', { name: 'Bottom text' }).fill('bottom');
    await expect(send).toBeEnabled();
    await dialog.getByRole('button', { name: 'Subtitle', exact: true }).click();
    const caption = dialog.getByRole('textbox', { name: 'Caption' });
    await expect(caption).toHaveJSProperty('tagName', 'INPUT');
    await dialog.getByRole('button', { name: 'Bar', exact: true }).click();
    await expect(caption).toHaveJSProperty('tagName', 'TEXTAREA');

    const startHandle = dialog.getByRole('slider', { name: 'Trim start' });
    await expect(startHandle).toHaveAttribute('aria-valuenow', '0.0');
    await startHandle.focus();
    await page.keyboard.press('ArrowRight', { delay: 10 });
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(startHandle).toHaveAttribute('aria-valuenow', '0.4');
    await expect(dialog.getByText('Trim · 0.4s – 2.0s of 2.0s')).toBeVisible();
    await page.keyboard.press('End');
    await expect(startHandle).toHaveAttribute('aria-valuenow', '1.7');

    await caption.fill('hello world');

    await caption.press('Shift+Enter');
    await expect(dialog).toBeHidden();
    await expect.poll(() => page.evaluate(() => capFixture.attached), { timeout: 60000 }).toEqual(['caption.gif']);
    expect(await page.evaluate(() => capFixture.posts.length)).toBe(0);

    const second = await addPickerResult(page);
    await second.dialog.getByRole('textbox', { name: 'Caption' }).fill('sent directly');
    await second.dialog.getByRole('textbox', { name: 'Caption' }).press('Enter');
    await expect(second.dialog).toBeHidden();
    await expect.poll(() => page.evaluate(() => capFixture.posts.length), { timeout: 60000 }).toBe(1);
    const post = await page.evaluate(() => ({ uploads: capFixture.uploads, post: capFixture.posts[0] }));
    expect(post.uploads).toEqual([{ name: 'caption.gif', type: 'image/gif', channel: '100' }]);
    expect(post.post.url).toBe('/channels/100/messages');
    expect(post.post.body.attachments).toEqual([{ id: '0', filename: 'caption.gif', uploaded_filename: 'up/caption.gif' }]);
    expect(post.post.body.message_reference).toBeUndefined();

    await page.evaluate(() => Lowcord.extensions.set('gifCaptioner', false));
    await expect(page.locator('.lowcord-gifcap-btn')).toHaveCount(0);
    await result.hover();
    await expect(page.locator('.lowcord-gifcap-btn')).toHaveCount(0);
});

test('favourites get a caption button, trending category tiles do not', async ({ page }) => {
    await page.evaluate(() => {
        document.querySelector('main').insertAdjacentHTML('beforeend',
            '<div id="gif-picker-tab-panel"><div class="result_test category" style="width:240px;height:160px"><img src="/media/sample.png" alt=""><span>zelda</span></div>'
            + '<div class="result_test clip" style="width:240px;height:160px"><img src="/media/sample.png" alt=""></div>'
            + '<div class="result_test favourite" style="width:240px;height:160px"><img src="/media/sample.png" alt=""></div></div>');
        const [category, clip, favourite] = document.querySelectorAll('#gif-picker-tab-panel [class*="result_"]');
        category.__reactFiber$test = { memoizedProps: { item: { name: 'zelda', src: 'https://media.tenor.com/abc/zelda.gif' } } };
        clip.__reactFiber$test = { memoizedProps: { item: { id: '1', src: 'https://media.tenor.com/abc/clip.mp4' } } };
        favourite.__reactFiber$test = { memoizedProps: { item: { format: 1, src: 'https://media.tenor.com/slf4mspyGvYAAAAM/cat.gif', url: 'https://tenor.com/view/x', width: 56, height: 56 } } };
    });
    for (const name of ['category', 'clip', 'favourite']) await page.locator(`.result_test.${name}`).hover();
    await expect(page.locator('.result_test.category .lowcord-gifcap-btn')).toHaveCount(0);
    await expect(page.locator('.result_test.clip .lowcord-gifcap-btn')).toHaveCount(1);
    await expect(page.locator('.result_test.favourite .lowcord-gifcap-btn')).toHaveCount(1);
});

test('a favourite GIF previews from its frames and sends a captioned GIF', async ({ page }) => {
    await mockDiscord(page);
    const gif = await page.evaluate(async () => {
        const bytes = new Uint8Array(await (await fetch('/media/sample.mp4')).arrayBuffer());
        const made = await Lowcord.gif.encode({ bytes, limit: 32 * 1024 * 1024, start: 0, end: .8,
            layout: (w, h) => ({ width: w, height: h, x: 0, y: 0, w, h }), drawOverlay: () => {} });
        return [...made];
    });
    await page.route('**/favourite/cat.gif', route => route.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from(gif) }));
    await page.evaluate(() => {
        document.querySelector('main').insertAdjacentHTML('beforeend',
            '<div id="gif-picker-tab-panel"><div class="result_test favourite" role="button" style="width:240px;height:160px"><img src="/media/sample.png" alt=""></div></div>');
        document.querySelector('.result_test.favourite').__reactFiber$test = { memoizedProps: { item: { format: 1, src: '/favourite/cat.gif', url: 'https://tenor.com/view/x' } } };
    });
    const result = page.locator('.result_test.favourite');
    await result.hover();
    await result.locator('.lowcord-gifcap-btn').click();
    const dialog = page.getByRole('dialog', { name: 'Caption GIF' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('slider', { name: 'Trim end' })).toHaveAttribute('aria-valuenow', '0.8');
    await expect.poll(() => page.evaluate(() => {
        const canvas = document.querySelector('.lowcord-gifcap-dialog canvas');
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let colored = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) colored++;
        return colored;
    })).toBeGreaterThan(100);
    await dialog.getByRole('textbox', { name: 'Caption' }).fill('favourite');
    await dialog.getByRole('textbox', { name: 'Caption' }).press('Enter');
    await expect(dialog).toBeHidden();
    await expect.poll(() => page.evaluate(() => capFixture.posts.length), { timeout: 60000 }).toBe(1);
    expect(await page.evaluate(() => capFixture.uploads)).toEqual([{ name: 'caption.gif', type: 'image/gif', channel: '100' }]);
});

test('message menu captions a GIF embed and replies to that message', async ({ page }) => {
    await mockDiscord(page);
    await page.evaluate(() => document.querySelector('main').insertAdjacentHTML('beforeend',
        '<ol><li id="chat-messages-100-200"><div class="message_test"><p class="text">look</p><video src="/media/sample.mp4" muted></video></div></li>'
        + '<li id="chat-messages-100-201"><div class="message_test"><p class="plain">no gif here</p></div></li></ol>'));
    const openMenu = async selector => page.evaluate(selector => {
        document.querySelector('#message')?.remove();
        document.querySelector(selector).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        document.body.insertAdjacentHTML('beforeend', '<div id="message" role="menu"><div id="message-reply" role="menuitem" class="item_x"><div class="label_x">Reply</div><svg></svg></div>'
            + '<div id="message-copy-text" role="menuitem" class="item_x"><div class="label_x">Copy Text</div></div></div>');
    }, selector);

    await openMenu('#chat-messages-100-201 .plain');
    await page.waitForTimeout(100);
    await expect(page.locator('#message-lowcord-caption-gif')).toHaveCount(0);

    await openMenu('#chat-messages-100-200 .text');
    const item = page.getByRole('menuitem', { name: 'Caption this GIF' });
    await expect(item).toBeVisible();
    expect(await page.evaluate(() => document.querySelector('#message-reply').nextElementSibling.id)).toBe('message-lowcord-caption-gif');
    await item.click();
    const dialog = page.getByRole('dialog', { name: 'Caption GIF' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Sends as a reply to pat/)).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Caption' }).fill('replying');
    await dialog.getByRole('textbox', { name: 'Caption' }).press('Enter');
    await expect.poll(() => page.evaluate(() => capFixture.posts.length), { timeout: 60000 }).toBe(1);
    expect(await page.evaluate(() => capFixture.posts[0].body.message_reference)).toEqual({ channel_id: '100', message_id: '200', guild_id: '300' });

    // Add to message: the file is queued and Discord's reply bar is set.
    await page.evaluate(() => document.querySelector('#message')?.remove());
    await openMenu('#chat-messages-100-200 video');
    await page.getByRole('menuitem', { name: 'Caption this GIF' }).click();
    await dialog.getByRole('textbox', { name: 'Caption' }).fill('later');
    await dialog.getByRole('button', { name: 'Add to message' }).click();
    await expect.poll(() => page.evaluate(() => capFixture.attached), { timeout: 60000 }).toEqual(['caption.gif']);
    expect(await page.evaluate(() => capFixture.replies)).toEqual([{ message: '200', channel: '100', shouldMention: true }]);

    await page.evaluate(() => Lowcord.extensions.set('gifCaptioner', false));
    await openMenu('#chat-messages-100-200 .text');
    await page.waitForTimeout(100);
    await expect(page.locator('#message-lowcord-caption-gif')).toHaveCount(0);
});
