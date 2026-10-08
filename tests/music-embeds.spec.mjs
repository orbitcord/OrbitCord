import { test, expect } from '@playwright/test';
const spotify = 'https://open.spotify.com/track/0Lr4kGOYn9l83EjuK6cZFQ';
const apple = 'https://music.apple.com/us/album/test/123456?i=789012';

test.beforeEach(async ({ page }) => {
    await page.route('https://open.spotify.com/embed/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Spotify player</p>' }));
    await page.route('https://embed.music.apple.com/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Apple Music player</p>' }));
    await page.goto('/extensions');
    await page.waitForFunction(() => window.fixtureReady);
    await page.evaluate(() => {
        const store = Lowcord.store;
        window.musicMessages = new Map();
        Lowcord.store = name => name === 'MessageStore' ? { getMessage: (_, id) => musicMessages.get(id) } : store(name);
    });
});

test('pasting music creates composer players and clearing the draft releases them', async ({ page }) => {
    await page.evaluate(() => {
        const editor = document.createElement('textarea'); editor.id = 'composer';
        document.querySelector('.channelTextArea_test').append(editor);
    });
    await page.locator('#composer').fill(`${spotify}\n${apple}`);
    const preview = page.getByLabel('Music link preview');
    await expect(preview.locator('iframe')).toHaveCount(2);
    await expect(preview.locator('iframe').nth(0)).toHaveAttribute('src', spotify.replace('/track/', '/embed/track/'));
    await expect(preview.locator('iframe').nth(1)).toHaveAttribute('src', apple.replace('music.apple.com', 'embed.music.apple.com'));
    await page.locator('#composer').fill('another message');
    await expect(preview).toHaveCount(0);
    await page.locator('#composer').fill(spotify);
    await expect(preview.locator('iframe')).toHaveCount(1);
    await page.evaluate(() => Lowcord.extensions.set('musicEmbeds', false));
    await expect(preview).toHaveCount(0);
});

test('multiline Slate drafts preserve separate music links and reuse their players', async ({ page }) => {
    await page.evaluate(() => {
        const editor = document.createElement('div'); editor.id = 'composer';
        editor.contentEditable = 'true'; editor.setAttribute('role', 'textbox');
        document.querySelector('.channelTextArea_test').append(editor);
    });
    await page.locator('#composer').fill(`${spotify}\n${apple}`);
    const players = page.locator('.lowcord-music-draft iframe');
    await expect(players).toHaveCount(2);
    await players.first().evaluate(e => window.originalDraftFrame = e);
    await page.locator('#composer').press('End');
    await page.locator('#composer').press('Enter');
    await page.locator('#composer').pressSequentially('another line');
    await expect(players).toHaveCount(2);
    expect(await players.first().evaluate(e => e === window.originalDraftFrame)).toBe(true);
    await page.locator('#composer').fill('');
    await expect(page.locator('.lowcord-music-draft')).toHaveCount(0);
});

test('a draft rewritten without an input event (send, draft restore) updates its players', async ({ page }) => {
    await page.evaluate(spotify => {
        const editor = document.createElement('div'); editor.id = 'composer';
        editor.contentEditable = 'true'; editor.setAttribute('role', 'textbox');
        editor.innerHTML = `<p><span>${spotify}</span></p>`;
        document.querySelector('.channelTextArea_test').append(editor);
    }, spotify);
    await expect(page.locator('.lowcord-music-draft iframe')).toHaveCount(1);
    await page.evaluate(() => { document.querySelector('#composer span').firstChild.data = ''; });
    await expect(page.locator('.lowcord-music-draft')).toHaveCount(0);
});

for (const width of [1000, 520, 320]) {
    test(`music drafts stay above the native composer without stretching it at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 700 });
        await page.addStyleTag({ content: `
            #composer-form { margin: 16px; width: calc(100% - 32px); }
            .channelBottomBarArea_test { display: flex; }
            .channelTextArea_test { flex: 1; min-width: 0; }
            #composer { display: block; box-sizing: border-box; width: 100%; height: 56px; }
        ` });
        await page.evaluate(() => {
            const form = document.createElement('form'); form.id = 'composer-form';
            const bottomBar = document.createElement('div'); bottomBar.className = 'channelBottomBarArea_test';
            const bar = document.querySelector('.channelTextArea_test');
            const editor = document.createElement('textarea'); editor.id = 'composer'; bar.append(editor);
            bottomBar.append(bar); form.append(bottomBar); document.querySelector('main').prepend(form);
        });
        const composer = page.locator('.channelTextArea_test');
        const baseline = await composer.boundingBox();
        for (const content of [spotify, apple, `${spotify}\n${apple}`]) {
            await page.locator('#composer').fill(content);
            const preview = page.getByLabel('Music link preview');
            await expect(preview.locator('iframe')).toHaveCount(content.includes('\n') ? 2 : 1);
            const draft = await preview.boundingBox();
            const input = await composer.boundingBox();
            expect(input.width).toBeCloseTo(baseline.width, 0);
            expect(input.height).toBeCloseTo(baseline.height, 0);
            expect(draft.y + draft.height).toBeLessThanOrEqual(input.y);
            for (const card of await preview.locator('.lowcord-music-player').all()) {
                const bounds = await card.boundingBox();
                expect(bounds.width).toBeLessThanOrEqual(draft.width);
                expect(bounds.x + bounds.width).toBeLessThanOrEqual(draft.x + draft.width + 1);
            }
            expect(await preview.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
        }
        await page.locator('#composer').fill('');
        await expect(page.getByLabel('Music link preview')).toHaveCount(0);
        expect((await composer.boundingBox()).height).toBeCloseTo(baseline.height, 0);
    });
}

test('plain sent links receive players, reuse keeps iframe state, and native players replace fallbacks', async ({ page }) => {
    await page.evaluate(({ spotify, apple }) => {
        musicMessages.set('123456', { content: `${spotify} ${apple}`, flags: 0 });
        const row = document.createElement('li'); row.id = 'chat-messages-987654-123456';
        const surface = document.createElement('div'); surface.dataset.listItemId = 'chat-messages-987654-123456';
        const body = document.createElement('div'); body.id = 'message-content-123456'; body.textContent = `${spotify} ${apple}`;
        surface.append(body); row.append(surface); document.querySelector('main').append(row);
    }, { spotify, apple });
    const players = page.locator('.lowcord-music-embeds iframe');
    await expect(players).toHaveCount(2);
    await players.nth(0).evaluate(iframe => { window.originalMusicFrame = iframe; });
    await page.evaluate(() => {
        musicMessages.get('123456').content += ' more text';
        document.getElementById('message-content-123456').append(document.createTextNode(' more text'));
    });
    expect(await players.nth(0).evaluate(iframe => iframe === window.originalMusicFrame)).toBe(true);
    await page.evaluate(spotify => {
        const frame = document.createElement('iframe'); frame.src = spotify.replace('/track/', '/embed/track/');
        frame.id = 'native-spotify'; document.querySelector('[data-list-item-id]').append(frame);
    }, spotify);
    await expect(players).toHaveCount(1);
    await expect(players).toHaveAttribute('title', 'Apple Music player');
    // Discord reuses row DOM when virtualizing; stale players must disappear.
    await page.evaluate(() => {
        musicMessages.get('123456').content = 'ordinary message';
        document.getElementById('message-content-123456').textContent = 'ordinary message';
    });
    await expect(players).toHaveCount(0);
});

test('code, suppressed links, duplicate links, and unrelated editors do not get extra players', async ({ page }) => {
    await page.evaluate(spotify => {
        const outside = document.createElement('textarea'); outside.id = 'other-editor'; document.body.append(outside);
        const editor = document.createElement('textarea'); editor.id = 'composer'; document.querySelector('.channelTextArea_test').append(editor);
    }, spotify);
    await page.locator('#other-editor').fill(spotify);
    await expect(page.locator('.lowcord-music-draft')).toHaveCount(0);
    await page.locator('#composer').fill(`\`${spotify}\` <${spotify}>`);
    await expect(page.locator('.lowcord-music-draft')).toHaveCount(0);
    await page.locator('#composer').fill(`${spotify} ${spotify}`);
    await expect(page.locator('.lowcord-music-draft iframe')).toHaveCount(1);
    expect(await page.evaluate(() => Lowcord.musicLinks.parse('https://open.spotify.com.evil.example/track/0Lr4kGOYn9l83EjuK6cZFQ'))).toBeNull();
});

test('localized Spotify and Apple album song links send canonical URLs while preserving song selection', async ({ page }) => {
    const requests = [];
    await page.route('**/api/v9/channels/987654/messages', async route => {
        requests.push(JSON.parse(route.request().postData())); await route.fulfill({ json: {} });
    });
    await page.evaluate(async ({ spotify, apple }) => {
        const content = `${spotify.replace('/track/', '/intl-hi/track/')}?si=tracking ${apple}&utm_source=share`;
        await fetch('/api/v9/channels/987654/messages', { method: 'POST', body: JSON.stringify({ content }) });
    }, { spotify, apple });
    expect(requests[0].content).toBe(`${spotify} ${apple}`);
});
