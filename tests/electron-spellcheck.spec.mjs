import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const launch = dataDir => electron.launch({ args: [resolve('.')], env: { ...process.env,
    LOWCORD_TEST: '1', LOWCORD_TEST_UPDATER: '0', LOWCORD_TEST_MEDIA_SOURCES: '0', LOWCORD_TEST_URL: 'http://127.0.0.1:4319/electron', LOWCORD_TEST_DATA: dataDir } });

test('spellcheck settings reach the window session, suggestions fill the edit menu, and autocorrect edits through native input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orbitcord-spellcheck-'));
    const app = await launch(dir);
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState('domcontentloaded');
        await expect.poll(() => page.evaluate(() => Boolean(window.Lowcord?.spellcheck))).toBe(true);
        const sessionState = () => app.evaluate(({ BrowserWindow }) => {
            const ses = BrowserWindow.getAllWindows()[0].webContents.session;
            return { enabled: ses.isSpellCheckerEnabled(), languages: ses.getSpellCheckerLanguages() };
        });
        // On by default, applied at startup.
        await expect.poll(async () => (await sessionState()).enabled).toBe(true);
        await page.evaluate(() => Lowcord.extensions.set('spellcheck', false));
        await expect.poll(async () => (await sessionState()).enabled).toBe(false);
        await page.evaluate(() => Lowcord.extensions.set('spellcheck', true));
        await expect.poll(async () => (await sessionState()).enabled).toBe(true);
        const offered = await page.evaluate(() => Lowcord.spellcheck.languages);
        if (process.platform === 'darwin') expect(offered).toEqual([]);
        else {
            expect(offered.length).toBeGreaterThan(1);
            const choice = offered.find(code => !code.startsWith('en')) ?? offered[0];
            await page.evaluate(code => Lowcord.extensions.setOption('spellcheckLanguage', code), choice);
            await expect.poll(async () => (await sessionState()).languages).toEqual([choice]);
        }
        // The main process checks what the page sends.
        await expect(page.evaluate(() => __LOWCORD_NATIVE__.spellcheck({ enabled: 'yes', language: 'auto' }))).rejects.toThrow('Invalid spellcheck settings');
        await expect(page.evaluate(() => __LOWCORD_NATIVE__.spellcheck({ enabled: true, language: '../en' }))).rejects.toThrow('Unknown spellcheck language');
        // Another account's partition keeps its own setting.
        expect(await app.evaluate(({ session, BrowserWindow }) => {
            const other = session.fromPartition('persist:spellcheck-other');
            other.setSpellCheckerEnabled(false);
            return [other.isSpellCheckerEnabled(), BrowserWindow.getAllWindows()[0].webContents.session.isSpellCheckerEnabled()];
        })).toEqual([false, true]);

        // Right-click a misspelling: suggestions, then Add to dictionary.
        await app.evaluate(({ BrowserWindow, Menu }) => {
            const contents = BrowserWindow.getAllWindows()[0].webContents;
            global.spellMenu = null;
            global.originalBuild = Menu.buildFromTemplate;
            Menu.buildFromTemplate = items => { global.spellMenu = items; return { popup() {} }; };
            contents.emit('context-menu', {}, { isEditable: true, selectionText: '', frame: contents.mainFrame, pageURL: contents.getURL(),
                misspelledWord: 'orbitcordy', dictionarySuggestions: ['orbit', 'orbits'],
                editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true } });
        });
        await expect.poll(() => app.evaluate(() => global.spellMenu?.map(item => item.label ?? item.type)))
            .toEqual(['orbit', 'orbits', 'Add to dictionary', 'separator', 'Cut', 'Copy', 'Paste', 'Paste and Match Style', 'separator', 'Select All']);
        await app.evaluate(async ({ BrowserWindow, Menu }) => {
            Menu.buildFromTemplate = global.originalBuild;
            global.spellMenu.find(item => item.label === 'Add to dictionary').click();
        });
        await expect.poll(() => app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].webContents.session.listWordsInSpellCheckerDictionary())).toContain('orbitcordy');

        // Autocorrect goes through webFrame.insertText, Chromium's own text input.
        await page.evaluate(() => {
            const box = document.createElement('div');
            box.className = 'channelTextArea_spell';
            box.innerHTML = '<div id="composer" contenteditable="true" role="textbox" aria-label="Message"></div>';
            document.body.append(box);
            window.inputs = [];
            box.addEventListener('beforeinput', event => inputs.push([event.inputType, event.data, event.isTrusted, event.getTargetRanges().length]));
            Lowcord.extensions.set('autocorrect', true);
        });
        await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].show(); BrowserWindow.getAllWindows()[0].focus(); });
        await page.locator('#composer').click();
        await page.keyboard.type('teh `teh ');
        await expect.poll(() => page.locator('#composer').evaluate(node => node.innerText.replace(/ /g, ' '))).toBe('the `teh ');
        // A real, trusted insert over the word, which editors like Slate apply by its target range.
        expect(await page.evaluate(() => inputs.find(([, data]) => data === 'the '))).toEqual(['insertText', 'the ', true, 1]);
        await page.locator('#composer').evaluate(node => { node.textContent = ''; });
        await page.keyboard.type('teh ');
        await page.keyboard.press('Backspace');
        await expect.poll(() => page.locator('#composer').evaluate(node => node.innerText)).toBe('teh');
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
