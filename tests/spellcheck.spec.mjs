import { test, expect } from '@playwright/test';

// The fixture stands in for the native bridge: spellcheck settings are
// recorded, and insertText edits the selection like webFrame.insertText.
test.beforeEach(async ({ page }) => {
    await page.goto('/extensions');
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
    await page.evaluate(async () => {
        window.spellcheckCalls = [];
        window.__LOWCORD_NATIVE__ = {
            spellcheck: async settings => {
                spellcheckCalls.push(settings);
                if (!['auto', 'en-US', 'fr'].includes(settings.language)) throw new Error('Unknown spellcheck language');
                return { enabled: settings.enabled, language: settings.language, languages: ['en-US', 'fr'], active: ['en-US'] };
            },
            insertText: text => document.execCommand('insertText', false, text),
        };
        const box = document.createElement('div');
        box.className = 'channelTextArea_spell';
        box.innerHTML = '<div id="composer" contenteditable="true" role="textbox" aria-label="Message"></div>';
        document.body.append(box);
        const script = document.createElement('script');
        script.textContent = await (await fetch('/injection/spellcheck.js')).text();
        document.head.append(script);
    });
});

const composer = page => page.locator('#composer');
async function typed(page, text) {
    await composer(page).evaluate(node => { node.textContent = ''; });
    await composer(page).click();
    await page.keyboard.type(text);
    // Corrections land a task after the space is drawn.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 20)));
    return composer(page).evaluate(node => node.innerText.replace(/ /g, ' '));
}

test('spellcheck is on and autocorrect off by default, and each change reaches the session', async ({ page }) => {
    expect(await page.evaluate(() => Lowcord.extensions.state)).toMatchObject({ spellcheck: true, autocorrect: false });
    await expect.poll(() => page.evaluate(() => spellcheckCalls)).toEqual([{ enabled: true, language: 'auto' }]);
    expect(await typed(page, 'teh cat ')).toBe('teh cat ');
    await page.evaluate(() => Lowcord.extensions.set('spellcheck', false));
    await page.evaluate(() => Lowcord.extensions.setOption('spellcheckLanguage', 'fr'));
    await page.evaluate(() => Lowcord.extensions.set('spellcheck', true));
    expect(await page.evaluate(() => spellcheckCalls)).toEqual([{ enabled: true, language: 'auto' },
        { enabled: false, language: 'auto' }, { enabled: false, language: 'fr' }, { enabled: true, language: 'fr' }]);
    await expect(() => page.evaluate(() => Lowcord.extensions.setOption('spellcheckLanguage', 'fr"><x'))).rejects.toThrow('Invalid language');
});

test('a saved dictionary the system lacks falls back to the system language', async ({ page }) => {
    await page.evaluate(() => Lowcord.extensions.setOption('spellcheckLanguage', 'xx-YY'));
    await expect.poll(() => page.evaluate(() => Lowcord.extensions.options.spellcheckLanguage)).toBe('auto');
    expect(await page.evaluate(() => spellcheckCalls.at(-1))).toEqual({ enabled: true, language: 'auto' });
});

test('the language picker lists the session dictionaries and hides with spellcheck off', async ({ page }) => {
    await page.evaluate(() => window.__lowcordOpenSettings('extensions'));
    const picker = page.getByLabel('Spellcheck language');
    await expect(picker).toHaveValue('auto');
    await expect(picker.locator('option')).toHaveText(['Same as system', 'American English', 'French']);
    await picker.selectOption('fr');
    await expect.poll(() => page.evaluate(() => spellcheckCalls.at(-1))).toEqual({ enabled: true, language: 'fr' });
    await page.getByRole('switch', { name: 'Spellcheck' }).uncheck();
    await expect(picker).toHaveCount(0);
});

test('autocorrect fixes typos on space, keeps case and punctuation, and Backspace undoes it', async ({ page }) => {
    await page.evaluate(() => Lowcord.extensions.set('autocorrect', true));
    expect(await typed(page, 'teh cat ')).toBe('the cat ');
    expect(await typed(page, 'Teh end. ')).toBe('The end. ');
    expect(await typed(page, 'TEH ')).toBe('THE ');
    expect(await typed(page, 'i dont know, (recieve) ')).toBe("I don't know, (receive) ");
    expect(await typed(page, 'teh')).toBe('teh');
    // Backspace right after a fix restores the word and keeps it from then on.
    await typed(page, 'see teh ');
    await page.keyboard.press('Backspace');
    expect(await composer(page).evaluate(node => node.innerText)).toBe('see teh');
    await page.keyboard.type(' ');
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 20)));
    expect(await composer(page).evaluate(node => node.innerText.replace(/ /g, ' '))).toBe('see teh ');
});

test('autocorrect leaves code, links, mentions, emoji and commands alone', async ({ page }) => {
    await page.evaluate(() => Lowcord.extensions.set('autocorrect', true));
    for (const text of ['`teh ', '`x` and `teh ', 'https://teh.com/teh ', 'www.teh ', 'teh.com ', '@teh ', '#teh ', ':teh ', ':teh: ', '<:teh:123> ', '/teh '])
        expect(await typed(page, text), text).toBe(text);
    expect(await typed(page, '`x` teh ')).toBe('`x` the ');
    // Inside an open code fence, across lines.
    await composer(page).evaluate(node => { node.textContent = ''; });
    await composer(page).click();
    await page.keyboard.type('```');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('teh ');
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 20)));
    expect(await composer(page).evaluate(node => node.innerText.replace(/ /g, ' '))).toMatch(/teh $/);
    // Mentions are non-editable islands in Discord's editor.
    await composer(page).evaluate(node => { node.innerHTML = '<span contenteditable="false">@teh</span>&nbsp;'; });
    expect(await page.evaluate(() => {
        const node = document.querySelector('#composer span').firstChild;
        getSelection().collapse(node, node.length);
        return Lowcord.extensions.autocorrect.candidate(document.querySelector('#composer'));
    })).toBeNull();
});

test('autocorrect only runs in the message box and stops when turned off', async ({ page }) => {
    await page.evaluate(() => {
        Lowcord.extensions.set('autocorrect', true);
        const other = document.createElement('div');
        other.innerHTML = '<div id="elsewhere" contenteditable="true" role="textbox"></div>';
        document.body.append(other);
    });
    await page.locator('#elsewhere').click();
    await page.keyboard.type('teh ');
    expect(await page.locator('#elsewhere').evaluate(node => node.innerText.replace(/ /g, ' '))).toBe('teh ');
    await page.evaluate(() => Lowcord.extensions.set('autocorrect', false));
    expect(await typed(page, 'teh ')).toBe('teh ');
});
