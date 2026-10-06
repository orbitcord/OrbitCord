import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const links = require('../electron/social-links.cjs');
const { createSocialPosts } = require('../electron/social-posts.cjs');
const { createSocialResolver } = require('../electron/social-resolver.cjs');
const { mux } = require('../electron/mp4-mux.cjs');
const jsonResponse = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const htmlResponse = body => new Response(body, { headers: { 'content-type': 'text/html' } });

test('every supported platform parses to one post key, and short links keep a working fallback', () => {
    const cases = [
        ['https://bsky.app/profile/bsky.app/post/3mv3shqdfuc2e', 'bluesky', '/profile/bsky.app/post/3mv3shqdfuc2e'],
        ['https://old.reddit.com/r/pics/comments/1wxvc6f/some_title/', 'reddit', '/r/pics/comments/1wxvc6f/some_title/'],
        ['https://redd.it/1wxvc6f', 'reddit', '/comments/1wxvc6f/'],
        ['https://www.reddit.com/r/pics/s/Oz6sJ1kfSx', 'reddit', '/r/pics/s/Oz6sJ1kfSx'],
        ['https://www.tiktok.com/@scout2015/video/6718335390845095173', 'tiktok', '/@scout2015/video/6718335390845095173'],
        ['https://vm.tiktok.com/ZMabc123/', 'tiktok', '/t/ZMabc123/'],
        ['https://clips.twitch.tv/OilyColdNigiriCclamChamp-xgMGfV91PIBdhydH', 'twitch', '/clip/OilyColdNigiriCclamChamp-xgMGfV91PIBdhydH'],
        ['https://www.twitch.tv/yololaryy/clip/Slug-1', 'twitch', '/yololaryy/clip/Slug-1'],
        ['https://staff.tumblr.com/post/828009069026721792/some-slug', 'tumblr', '/staff/828009069026721792'],
        ['https://www.tumblr.com/staff/828009069026721792', 'tumblr', '/staff/828009069026721792'],
        ['https://www.facebook.com/permalink.php?story_fbid=123&id=456&mibextid=track', 'facebook', '/permalink.php?story_fbid=123&id=456'],
        ['https://www.facebook.com/share/r/AbC123/', 'facebook', '/share/r/AbC123/'],
        ['https://www.threads.net/@zuck/post/C1a2b3', 'threads', '/@zuck/post/C1a2b3'],
        ['https://www.pixiv.net/en/artworks/123456789', 'pixiv', '/en/artworks/123456789'],
    ];
    for (const [url, site, path] of cases) expect(links.parse(url), url).toMatchObject({ site, path, original: true });
    expect(links.parse('https://redd.it/1wxvc6f').canonical).toBe('https://www.reddit.com/comments/1wxvc6f/');
    expect(links.parse('https://clips.twitch.tv/Slug-1').canonical).toBe('https://clips.twitch.tv/Slug-1');
    expect(links.parse('https://vxreddit.com/r/pics/comments/1wxvc6f/x/').key).toBe(links.parse('https://reddit.com/r/pics/comments/1wxvc6f/x').key);
    for (const url of ['https://bsky.app.evil.example/profile/a/post/b', 'https://www.reddit.com/r/pics/', 'https://evil-tumblr.com/post/1',
        'https://www.tiktok.com/@user', 'https://www.facebook.com/profile.php?id=1', 'https://clips.twitch.tv/embed', 'https://x.com@evil.example/u/status/1'])
        expect(links.parse(url), url).toBeNull();
    expect(links.rewrite('see https://redd.it/1wxvc6f and https://bsky.app/profile/a.b/post/xyz', target => links.providers[target.site][0]))
        .toBe('see https://vxreddit.com/comments/1wxvc6f/ and https://bskx.app/profile/a.b/post/xyz');
});

test('auto mode falls back to the canonical service URL for every platform', async () => {
    const resolver = createSocialResolver(async () => htmlResponse('<html>no media</html>'));
    expect(await resolver.resolve('https://redd.it/1wxvc6f')).toBe('https://www.reddit.com/comments/1wxvc6f/');
    expect(await resolver.resolve('https://vm.tiktok.com/ZMabc123')).toBe('https://www.tiktok.com/t/ZMabc123');
    const working = createSocialResolver(async url => url.startsWith('https://rxddit.com')
        ? htmlResponse('<meta property="og:image" content="https://i.redd.it/a.jpg">') : htmlResponse('down'));
    expect(await working.resolve('https://www.reddit.com/r/pics/comments/abc/t/')).toBe('https://rxddit.com/r/pics/comments/abc/t/');
});

test('Reddit, Instagram and Bluesky posts expose every carousel item through minted media tokens', async () => {
    const calls = [];
    const posts = createSocialPosts(async (url, init) => {
        calls.push({ url, init });
        if (url.startsWith('https://api.reddit.com/comments/')) return jsonResponse([{ data: { children: [{ data: {
            title: 'Two photos', selftext: '', author: 'someone', subreddit: 'pics', subreddit_name_prefixed: 'r/pics', permalink: '/r/pics/comments/abc/two/',
            score: 10, num_comments: 2, created_utc: 1700000000, over_18: false,
            gallery_data: { items: [{ media_id: 'one' }, { media_id: 'two', caption: 'second' }] },
            media_metadata: { one: { status: 'valid', e: 'Image', s: { u: 'https://i.redd.it/one.jpg', x: 4, y: 3 } },
                two: { status: 'valid', e: 'AnimatedImage', s: { mp4: 'https://i.redd.it/two.mp4', x: 1, y: 1 } } },
        } }] } }]);
        if (url.includes('/about')) return jsonResponse({ data: { community_icon: 'https://styles.redditmedia.com/icon.png' } });
        if (url.startsWith('https://zzinstagram.com/')) {
            const index = Number(new URL(url).searchParams.get('img_index'));
            const shown = Math.min(index, 3);
            return htmlResponse(`<meta property="og:title" content="Name (@handle)"><meta property="og:image" content="https://g.oginstagram.com/offload/CODE/${shown}?thumbnail=1">${shown === 2 ? `<meta property="og:video" content="https://g.oginstagram.com/offload/CODE/${shown}">` : ''}`);
        }
        if (url.startsWith('https://public.api.bsky.app/')) return jsonResponse({ thread: { post: {
            author: { did: 'did:plc:abc', handle: 'a.bsky.social', displayName: 'A' }, record: { text: 'hi', createdAt: '2026-01-01T00:00:00Z' },
            likeCount: 3, embed: { $type: 'app.bsky.embed.images#view', images: [1, 2, 3, 4].map(n => ({ fullsize: `https://cdn.bsky.app/${n}.jpg`, alt: `${n}` })) },
        } } });
        return new Response('missing', { status: 404 });
    });
    const reddit = await posts.get('https://www.reddit.com/r/pics/comments/abc/two/');
    expect(reddit).toMatchObject({ site: 'reddit', title: 'Two photos', author: { name: 'r/pics', handle: 'u/someone' }, stats: { score: 10, comments: 2 } });
    expect(reddit.media.map(item => [item.type, item.width, item.alt])).toEqual([['image', 4, undefined], ['video', 1, 'second']]);
    expect(reddit.media.every(item => /^lowcord-media:\/\/media\/[\da-f]{24}$/.test(item.src))).toBe(true);
    expect(calls.every(({ init }) => init.credentials === 'omit')).toBe(true);
    const instagram = await posts.get('https://www.instagram.com/p/CODE/');
    expect(instagram.media.map(item => item.type)).toEqual(['image', 'video', 'image']);
    expect(instagram.author).toMatchObject({ name: 'Name', handle: '@handle' });
    const bluesky = await posts.get('https://bsky.app/profile/a.bsky.social/post/xyz');
    expect(bluesky.media).toHaveLength(4);
    // Cached: a second card for the same post makes no requests.
    const count = calls.length;
    await posts.get('https://vxreddit.com/r/pics/comments/abc/two/');
    expect(calls.length).toBe(count);
    // Only minted tokens are served, and remote pages never render from the scheme.
    expect((await posts.serve(new Request('http://media/0123456789abcdef01234567'))).status).toBe(404);
});

test('Instagram photo slides that redirect to the image keep the carousel, its videos and caption', async () => {
    const photo = n => `https://scontent.cdninstagram.com/v/${n}.jpg`;
    const posts = createSocialPosts(async (url, init) => {
        if (url.startsWith('https://zzinstagram.com/')) {
            const index = Math.min(4, Number(new URL(url).searchParams.get('img_index')));
            expect(init.redirect).toBe('manual');
            if (index % 2) return htmlResponse(`<meta property="og:title" content="Name (@handle)"><meta property="og:image" content="https://g.oginstagram.com/offload/CODE/${index}?thumbnail=1"><meta property="og:video" content="https://g.oginstagram.com/offload/CODE/${index}">`);
            return new Response(null, { status: 302, headers: { location: photo(index) } });
        }
        if (url.startsWith('https://hhinstagram.com/p/')) return htmlResponse('<meta property="og:description" content="❤️ 1.5K · 💬 3 · 🖼️ 1/4\nCaption">');
        return new Response('missing', { status: 404 });
    });
    const post = await posts.get('https://www.instagram.com/p/CODE/');
    expect(post.media.map(item => item.type)).toEqual(['video', 'image', 'video', 'image']);
    expect(post).toMatchObject({ text: 'Caption', stats: { likes: 1500, comments: 3 }, author: { handle: '@handle' } });
});

test('X and Reddit GIFs loop in the card and download flagged as GIFs', async () => {
    const posts = createSocialPosts(async (url, init) => {
        if (url.startsWith('https://api.fxtwitter.com/')) return jsonResponse({ tweet: { text: 't', author: { name: 'n', screen_name: 's' },
            media: { all: [{ type: 'gif', url: 'https://video.twimg.com/tweet_video/a.mp4', thumbnail_url: 'https://pbs.twimg.com/a.jpg' }] } } });
        if (url.startsWith('https://api.reddit.com/comments/')) return jsonResponse([{ data: { children: [{ data: {
            title: 'gif', author: 'a', subreddit: 'gifs', subreddit_name_prefixed: 'r/gifs', permalink: '/r/gifs/comments/abc/gif/',
            secure_media: { reddit_video: { fallback_url: 'https://v.redd.it/abc/DASH_720.mp4', is_gif: true, width: 1, height: 1 } },
        } }] } }]);
        if (url.endsWith('DASHPlaylist.mpd')) return new Response('<BaseURL>DASH_720.mp4</BaseURL><BaseURL>DASH_480.mp4</BaseURL><BaseURL>DASH_AUDIO_128.mp4</BaseURL>');
        if (url.endsWith('.mp4')) return new Response(init.method === 'HEAD' ? null : url.slice(-12), { headers: { 'content-length': '12' } });
        throw new Error(`must not fetch ${url}`);
    });
    const tweet = await posts.get('https://x.com/s/status/1');
    expect(tweet.media).toEqual([expect.objectContaining({ type: 'video', gif: true, loop: true })]);
    expect(await posts.socialVideo('https://x.com/s/status/1', 10 * 1024 * 1024)).toMatchObject({ name: 'x-1.mp4', gif: true });
    // Silent, and the 480p stream, since the GIF is no larger than that.
    const reddit = await posts.socialVideo('https://www.reddit.com/r/gifs/comments/abc/gif/', 10 * 1024 * 1024);
    expect([reddit.gif, Buffer.from(reddit.data).toString()]).toEqual([true, 'DASH_480.mp4']);
});

test('a photo carousel downloads every item as a typed file within one limit', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const png = Buffer.from('\x89PNG\r\n\x1a\n1234', 'latin1');
    const tweet = media => async (url, init) => {
        if (url.startsWith('https://api.fxtwitter.com/')) return jsonResponse({ tweet: { text: 't', author: { name: 'n', screen_name: 's' }, media: { all: media } } });
        if (url === 'https://pbs.twimg.com/a.jpg') return new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } });
        // A CDN that labels its files generically is still read by content.
        if (url === 'https://pbs.twimg.com/b') return new Response(png, { headers: { 'content-type': 'application/octet-stream' } });
        if (url === 'https://pbs.twimg.com/page') return new Response('<html>', { headers: { 'content-type': 'text/html' } });
        throw new Error(`must not fetch ${url} ${init?.method ?? ''}`);
    };
    const photo = url => ({ type: 'photo', url, width: 1, height: 1 });
    const files = (await createSocialPosts(tweet([photo('https://pbs.twimg.com/a.jpg'), photo('https://pbs.twimg.com/b')]))
        .socialMedia('https://x.com/s/status/1', 10 * 1024 * 1024)).files;
    expect(files.map(({ name, type }) => ({ name, type }))).toEqual([{ name: 'x-1-1.jpg', type: 'image/jpeg' }, { name: 'x-1-2.png', type: 'image/png' }]);
    expect(Buffer.from(files[0].data)).toEqual(jpeg);
    const single = await createSocialPosts(tweet([photo('https://pbs.twimg.com/a.jpg')])).socialMedia('https://x.com/s/status/1', 1024 * 1024);
    expect(single.files.map(file => file.name)).toEqual(['x-1.jpg']);
    await expect(createSocialPosts(tweet([photo('https://pbs.twimg.com/page')])).socialMedia('https://x.com/s/status/1', 1024 * 1024)).rejects.toThrow();
    await expect(createSocialPosts(tweet(Array(11).fill(photo('https://pbs.twimg.com/a.jpg')))).socialMedia('https://x.com/s/status/1', 1024 * 1024))
        .rejects.toMatchObject({ code: 'too-many' });
    await expect(createSocialPosts(tweet([])).socialMedia('https://x.com/s/status/1', 1024 * 1024)).rejects.toMatchObject({ code: 'not-media' });
});

test('a GIF post’s MP4 becomes a looping GIF within the size limit', async ({ page }) => {
    await page.goto('/extensions');
    await page.waitForFunction(() => window.fixtureReady);
    const result = await page.evaluate(async () => {
        const mp4 = new Uint8Array(await (await fetch('/media/dash-video.mp4')).arrayBuffer());
        const gif = await Lowcord.gif.fromVideo(mp4, 8 * 1024 * 1024);
        const decoder = new ImageDecoder({ data: gif, type: 'image/gif' });
        await decoder.tracks.ready;
        const { image } = await decoder.decode({ frameIndex: 0 });
        const canvas = new OffscreenCanvas(image.displayWidth, image.displayHeight);
        canvas.getContext('2d').drawImage(image, 0, 0);
        const decoded = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        // The same frame straight from the video, to compare colours.
        const video = Object.assign(document.createElement('video'), { muted: true, src: URL.createObjectURL(new Blob([mp4], { type: 'video/mp4' })) });
        await new Promise(resolve => { video.onloadeddata = resolve; });
        video.currentTime = 0; await new Promise(resolve => { video.onseeked = resolve; });
        const reference = new OffscreenCanvas(canvas.width, canvas.height).getContext('2d');
        reference.drawImage(video, 0, 0, canvas.width, canvas.height);
        const expected = reference.getImageData(0, 0, canvas.width, canvas.height).data;
        let error = 0;
        for (let i = 0; i < decoded.length; i += 4) for (let c = 0; c < 3; c++) error += Math.abs(decoded[i + c] - expected[i + c]);
        const tiny = await Lowcord.gif.fromVideo(mp4, 64);
        return { header: new TextDecoder().decode(gif.slice(0, 6)), frames: decoder.tracks.selectedTrack.frameCount,
            width: canvas.width, size: gif.length, error: error / (decoded.length / 4 * 3), tiny };
    });
    expect(result).toMatchObject({ header: 'GIF89a', width: 160, tiny: null });
    expect(result.frames).toBeGreaterThan(20);
    expect(result.error).toBeLessThan(12);
});

test('media scheme forwards ranges for minted URLs and refuses HTML', async () => {
    const posts = createSocialPosts(async (url, init) => {
        if (url.startsWith('https://api.fxtwitter.com/')) return jsonResponse({ tweet: { text: 't', author: { name: 'n', screen_name: 's' },
            media: { all: [{ type: 'photo', url: 'https://pbs.twimg.com/a.jpg' }, { type: 'photo', url: 'https://pbs.twimg.com/page.html' }] } } });
        if (url.endsWith('.html')) return htmlResponse('<script>alert(1)</script>');
        return new Response('abc', { status: 206, headers: { 'content-type': 'image/jpeg', 'content-range': `bytes 0-2/9`, 'x-range': init.headers.range } });
    });
    const post = await posts.get('https://x.com/s/status/1');
    const image = await posts.serve(new Request(post.media[0].src.replace('lowcord-media:', 'http:'), { headers: { range: 'bytes=0-2' } }));
    expect([image.status, image.headers.get('content-range'), await image.text()]).toEqual([206, 'bytes 0-2/9', 'abc']);
    expect((await posts.serve(new Request(post.media[1].src.replace('lowcord-media:', 'http:')))).status).toBe(415);
});

test('muxed Reddit-style streams play in Chromium with both tracks and the full duration', async ({ page }) => {
    const output = mux(await readFile('tests/fixtures/media/dash-video.mp4'), await readFile('tests/fixtures/media/dash-audio.mp4'));
    await page.goto('/extensions');
    const result = await page.evaluate(async bytes => {
        const video = document.createElement('video');
        video.muted = true;
        video.src = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }));
        document.body.append(video);
        await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error(video.error?.message)); });
        await video.play();
        await new Promise(resolve => setTimeout(resolve, 400));
        return { duration: video.duration, width: video.videoWidth, audio: video.webkitAudioDecodedByteCount > 0, video: video.webkitVideoDecodedByteCount > 0 };
    }, [...output]);
    expect(result).toMatchObject({ width: 160, audio: true, video: true });
    expect(result.duration).toBeGreaterThan(1.9);
    expect(() => mux(Buffer.from('not a video'), Buffer.from('nope'))).toThrow();
});

test.describe('chat cards', () => {
    const post = 'https://www.reddit.com/r/pics/comments/abc/two/';
    test.beforeEach(async ({ page }) => {
        await page.goto('/extensions');
        await page.waitForFunction(() => window.fixtureReady);
        await page.evaluate(() => {
            const store = Lowcord.store;
            window.socialMessages = new Map();
            window.postRequests = [];
            Lowcord.store = name => name === 'MessageStore' ? { getMessage: (_, id) => socialMessages.get(id) }
                : name === 'ChannelStore' ? { getChannel: () => ({ nsfw: false }) } : store(name);
            window.__LOWCORD_NATIVE__ = { socialPost: async url => {
                postRequests.push(url);
                return { site: 'reddit', service: 'Reddit', color: '#ff4500', url: 'https://www.reddit.com/r/pics/comments/abc/two/',
                    title: 'Two photos', text: 'Body', author: { name: 'r/pics', handle: 'u/someone', url: 'javascript:alert(1)' },
                    stats: { score: 1200, comments: 4 }, created: Date.UTC(2026, 0, 1), sensitive: url.includes('nsfw'),
                    // Fixture URLs stand in for minted lowcord-media URLs.
                    media: [{ type: 'image', src: `${location.origin}/media/sample.png`, width: 32, height: 24 }, { type: 'image', src: `${location.origin}/media/sample.png` },
                        { type: 'video', src: `${location.origin}/media/sample.mp4`, poster: `${location.origin}/media/sample.png` }] };
            } };
            window.addRow = (id, content, flags = 0) => {
                socialMessages.set(id, { content, flags });
                const row = document.createElement('li'); row.id = `chat-messages-987654-${id}`;
                const surface = document.createElement('div'); surface.dataset.listItemId = row.id;
                const body = document.createElement('div'); body.id = `message-content-${id}`; body.textContent = content;
                const accessories = document.createElement('div'); accessories.id = `message-accessories-${id}`;
                const embed = document.createElement('article'); embed.className = 'embedWrapper_test';
                const anchor = document.createElement('a'); anchor.href = 'https://vxreddit.com/r/pics/comments/abc/two/'; anchor.textContent = 'native';
                embed.append(anchor); accessories.append(embed);
                surface.append(body, accessories); row.append(surface); document.querySelector('main').append(row);
            };
        });
    });

    test('a carousel card replaces the native embed and pages through every item', async ({ page }) => {
        await page.evaluate(post => addRow('1', `look ${post} and again ${post.replace('www.', 'old.')}`), post);
        const card = page.locator('.lowcord-social-card');
        await expect(card).toHaveCount(1);
        await expect(page.locator('article.embedWrapper_test')).toBeHidden();
        await expect(card.locator('.lowcord-social-count')).toHaveText('1 / 3');
        await expect(card.locator('.lowcord-social-title')).toHaveText('Two photos');
        await expect(card.locator('.lowcord-social-name')).not.toHaveAttribute('href', /javascript/);
        await card.getByRole('button', { name: 'Next item' }).click();
        await expect(card.locator('.lowcord-social-count')).toHaveText('2 / 3');
        await card.locator('.lowcord-social-track').press('ArrowRight');
        await expect(card.locator('.lowcord-social-count')).toHaveText('3 / 3');
        await expect(card.getByRole('button', { name: 'Next item' })).toBeDisabled();
        await expect(card.locator('video')).toHaveAttribute('preload', 'none');
        expect(await page.evaluate(() => postRequests.length)).toBe(1);
        await page.evaluate(() => Lowcord.extensions.set('socialCards', false));
        await expect(card).toHaveCount(0);
        await expect(page.locator('article.embedWrapper_test')).toBeVisible();
    });

    test('sensitive media is concealed, and suppressed or code links get no card', async ({ page }) => {
        await page.evaluate(post => {
            addRow('2', post.replace('two', 'nsfw'));
            addRow('3', `\`${post}\``);
            addRow('4', post, 4);
        }, post);
        await expect(page.locator('.lowcord-social-card')).toHaveCount(1);
        await expect(page.locator('.lowcord-social-carousel')).toHaveClass(/lowcord-social-concealed/);
        await page.getByRole('button', { name: 'Sensitive content · Show' }).click();
        await expect(page.locator('.lowcord-social-carousel')).not.toHaveClass(/lowcord-social-concealed/);
        await expect(page.locator('#chat-messages-987654-3 article.embedWrapper_test')).toBeVisible();
        await expect(page.locator('#chat-messages-987654-4 article.embedWrapper_test')).toBeVisible();
    });

    test('native embeds without a post link are matched by the message’s embed URL', async ({ page }) => {
        await page.evaluate(post => {
            // A share link and an X-style embed that links only to the author.
            addRow('6', 'https://www.reddit.com/r/pics/s/Oz6sJ1kfSx');
            socialMessages.get('6').embeds = [{ url: 'https://www.reddit.com/r/pics/s/Oz6sJ1kfSx' }];
            const anchor = document.querySelector('#chat-messages-987654-6 article a');
            anchor.href = 'https://www.reddit.com/r/pics/';
            addRow('7', post);
            document.querySelector('#chat-messages-987654-7 article a').href = 'https://www.reddit.com/comments/abc';
            Lowcord.socialEmbeds.refresh();
        }, post);
        await expect(page.locator('.lowcord-social-card')).toHaveCount(2);
        await expect(page.locator('#chat-messages-987654-6 article.embedWrapper_test')).toBeHidden();
        await expect(page.locator('#chat-messages-987654-7 article.embedWrapper_test')).toBeHidden();
    });

    test('a failed lookup keeps Discord’s native embed', async ({ page }) => {
        await page.evaluate(() => { window.__LOWCORD_NATIVE__.socialPost = async () => null; });
        await page.evaluate(post => addRow('5', post), post);
        await expect(page.locator('#chat-messages-987654-5 article.embedWrapper_test')).toBeVisible();
        await expect(page.locator('.lowcord-social-card')).toHaveCount(0);
    });
});

test.describe('Videos as files', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/extensions');
        await page.waitForFunction(() => window.fixtureReady);
        await page.evaluate(() => {
            const editor = document.createElement('div');
            editor.contentEditable = 'true'; editor.setAttribute('role', 'textbox'); editor.id = 'composer';
            document.querySelector('.channelTextArea_test').append(editor);
            window.channel = String(Math.floor(Math.random() * 1e9));
            // Discord's composer takes pasted files as attachments.
            window.attached = [];
            editor.addEventListener('paste', event => { for (const file of event.clipboardData.files) attached.push(file.name); });
            const stores = { SelectedChannelStore: { getChannelId: () => channel } };
            Object.defineProperty(Lowcord, 'store', { configurable: true, value: name => stores[name] });
            window.pasteText = text => {
                editor.focus();
                const data = new DataTransfer(); data.setData('text/plain', text);
                editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
            };
            // Like Discord: Enter sends the composer's text with its attachments.
            window.sendMessage = () => new Promise(resolve => {
                const request = new XMLHttpRequest();
                request.open('POST', `/api/v9/channels/${channel}/messages`);
                request.setRequestHeader('Content-Type', 'application/json');
                request.onreadystatechange = () => { if (request.readyState === 4) resolve(); };
                request.send(JSON.stringify({ content: editor.textContent, nonce: '1',
                    attachments: attached.map((filename, id) => ({ id: String(id), filename, uploaded_filename: `uploads/${filename}` })) }));
            });
            window.sends = 0;
            editor.addEventListener('keydown', event => { if (event.key === 'Enter') { sends++; void sendMessage(); } });
        });
    });
    const link = 'https://www.reddit.com/r/oddlysatisfying/comments/1wxyc04/screw_sorting/';
    const fixed = link.replace('www.reddit.com', 'vxreddit.com');
    const tweet = 'https://x.com/someone/status/1234567890';
    const lastMessage = page => page.evaluate(async () => {
        const entries = (await (await fetch('/__received')).json()).filter(entry => entry.path === `/api/v9/channels/${channel}/messages`);
        return entries.length ? JSON.parse(entries.at(-1).body) : null;
    });
    const video = name => ({ name, type: 'video/mp4', data: new Uint8Array(8) });

    test('the link appears at once, the video is attached when ready, and the link is not sent', async ({ page }) => {
        await page.evaluate(() => { window.__LOWCORD_NATIVE__ = { socialVideo: (url, limit) => {
            window.videoRequest = { url, limit };
            return new Promise(resolve => { window.finishDownload = () => resolve({ name: 'reddit-1wxyc04.mp4', type: 'video/mp4', data: new Uint8Array(8) }); });
        } }; });
        await page.evaluate(link => pasteText(link), link);
        await expect(page.locator('#composer')).toHaveText(fixed);
        expect(await page.evaluate(() => window.videoRequest)).toEqual({ url: link, limit: 10 * 1024 * 1024 });
        await page.evaluate(() => finishDownload());
        await expect.poll(() => page.evaluate(() => attached)).toEqual([expect.stringMatching(/^[a-z]{7}\.mp4$/)]);
        await page.evaluate(() => sendMessage());
        const body = await lastMessage(page);
        expect(body.content).toBe('');
        expect(body.attachments).toHaveLength(1);
    });

    test('Enter before the download finishes waits, then sends once with the video', async ({ page }) => {
        await page.evaluate(() => { window.__LOWCORD_NATIVE__ = {
            socialPost: async () => ({ media: [{ type: 'video' }] }),
            socialVideo: () => new Promise(resolve => { window.finishDownload = () => resolve({ name: 'x-1.mp4', type: 'video/mp4', data: new Uint8Array(4) }); }),
        }; });
        await page.evaluate(tweet => pasteText(`${tweet} lol`), tweet);
        await page.evaluate(tweet => pasteText(tweet), tweet);
        await expect(page.locator('.lowcord-toast')).toContainText('It will be sent as a video');
        await page.locator('#composer').press('Enter');
        await page.locator('#composer').press('Enter');
        expect(await page.evaluate(() => sends)).toBe(0);
        await page.evaluate(() => finishDownload());
        await expect.poll(() => page.evaluate(() => sends)).toBe(1);
        await expect.poll(() => lastMessage(page)).toMatchObject({ content: 'lol', attachments: [{ id: '0' }] });
        // The link left the composer first, so Discord's upload row shows only the video.
        await expect(page.locator('#composer')).not.toContainText('x.com');
    });

    test('a GIF post is attached as a GIF file, not a video', async ({ page }) => {
        await page.evaluate(() => { window.__LOWCORD_NATIVE__ = {
            socialPost: async () => ({ media: [{ type: 'video', gif: true }] }),
            socialVideo: async () => ({ name: 'x-1.mp4', type: 'video/mp4', gif: true, data: new Uint8Array(4) }),
        }; });
        await page.evaluate(() => {
            window.attachedTypes = [];
            document.getElementById('composer').addEventListener('paste', event => { for (const file of event.clipboardData.files) attachedTypes.push(file.type); });
            Lowcord.gif.fromVideo = async () => new Uint8Array([71, 73, 70, 56, 57, 97]);
        });
        await page.evaluate(tweet => pasteText(tweet), tweet);
        await expect.poll(() => page.evaluate(() => attached)).toEqual([expect.stringMatching(/^[a-z]{7}\.gif$/)]);
        expect(await page.evaluate(() => attachedTypes)).toEqual(['image/gif']);
        await expect(page.locator('.lowcord-toast')).toContainText('GIF attached');
    });

    test('Enter while a carousel is still being checked sends without a video notice', async ({ page }) => {
        await page.evaluate(() => { window.__LOWCORD_NATIVE__ = {
            socialPost: () => new Promise(resolve => { window.finishPost = () => resolve({ media: [{ type: 'image' }, { type: 'video' }] }); }),
            socialVideo: () => Promise.reject(new Error('must not download')),
        }; });
        await page.evaluate(link => pasteText(link), link);
        await page.locator('#composer').press('Enter');
        await page.evaluate(() => finishPost());
        await expect.poll(() => page.evaluate(() => sends)).toBe(1);
        await expect(page.locator('.lowcord-toast')).toHaveCount(0);
    });

    test('a carousel is attached as every photo, and the link is not sent', async ({ page }) => {
        await page.evaluate(() => Lowcord.extensions.set('socialPhotoUpload', true));
        await page.evaluate(() => { window.__LOWCORD_NATIVE__ = {
            socialPost: async () => ({ media: [{ type: 'image' }, { type: 'image' }, { type: 'image' }] }),
            socialVideo: () => Promise.reject(new Error('must not download a video')),
            socialMedia: (url, limit) => {
                window.mediaRequest = { url, limit };
                return Promise.resolve({ files: [1, 2, 3].map(index => ({ name: `x-1-${index}.jpg`, type: 'image/jpeg', data: new Uint8Array(4) })) });
            },
        }; });
        await page.evaluate(tweet => pasteText(tweet), tweet);
        await expect.poll(() => page.evaluate(() => attached)).toEqual(Array(3).fill(expect.stringMatching(/^[a-z]{7}\.jpg$/)));
        expect(await page.evaluate(() => window.mediaRequest)).toEqual({ url: tweet, limit: 10 * 1024 * 1024 });
        await expect(page.locator('.lowcord-toast')).toContainText('X photos attached');
        await page.evaluate(() => sendMessage());
        const body = await lastMessage(page);
        expect(body.content).toBe('');
        expect(body.attachments).toHaveLength(3);
    });

    test('the photos toggle and posts over 10 items keep the link', async ({ page }) => {
        await page.evaluate(() => Lowcord.extensions.set('socialPhotoUpload', true));
        await page.evaluate(() => { window.__LOWCORD_NATIVE__ = {
            socialPost: async url => ({ media: Array(url.includes('/2') ? 11 : 2).fill({ type: 'image' }) }),
            socialVideo: () => Promise.reject(new Error('must not download a video')),
            socialMedia: () => Promise.reject(new Error('must not download')),
        }; });
        await page.evaluate(tweet => pasteText(tweet), tweet.replace(/\d+$/, '2'));
        await expect(page.locator('.lowcord-toast-failure')).toContainText('more than 10 items');
        await page.evaluate(() => { document.getElementById('composer').textContent = ''; Lowcord.extensions.set('socialPhotoUpload', false); });
        await page.evaluate(tweet => pasteText(tweet), tweet);
        await page.evaluate(() => sendMessage());
        expect((await lastMessage(page)).content).toContain('/status/1234567890');
        expect(await page.evaluate(() => attached)).toEqual([]);
    });

    test('image posts, oversized videos and the disabled toggle send the link', async ({ page }) => {
        await page.evaluate(() => { window.__LOWCORD_NATIVE__ = {
            socialPost: async url => url.includes('gallery') ? { media: [{ type: 'image' }, { type: 'image' }] } : null,
            socialVideo: async url => url.includes('gallery') ? Promise.reject(new Error('must not download')) : { error: 'too-large' },
        }; });
        const gallery = link.replace('screw_sorting', 'gallery');
        await page.evaluate(gallery => pasteText(gallery), gallery);
        await page.locator('#composer').press('Enter');
        await expect.poll(() => lastMessage(page)).toMatchObject({ content: gallery.replace('www.reddit.com', 'vxreddit.com') });
        await page.evaluate(() => { document.getElementById('composer').textContent = ''; });
        const big = link.replace('1wxyc04', 'big1').replace('screw_sorting', 'big');
        await page.evaluate(big => pasteText(big), big);
        await expect(page.locator('.lowcord-toast-failure')).toContainText('too large to upload');
        await page.evaluate(() => sendMessage());
        expect((await lastMessage(page)).content).toContain('/comments/big1/');
        await page.evaluate(() => { document.getElementById('composer').textContent = ''; Lowcord.extensions.set('redditVideoUpload', false); window.__LOWCORD_NATIVE__.socialVideo = () => { throw new Error('must not download'); }; });
        await page.evaluate(link => pasteText(link), link);
        await page.evaluate(() => sendMessage());
        expect((await lastMessage(page)).content).toBe(fixed);
        expect(await page.evaluate(() => attached)).toEqual([]);
    });
});
