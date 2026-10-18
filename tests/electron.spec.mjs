import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

async function launch(dataDir, { updater = false, mediaSources = false } = {}) {
    const app = await electron.launch({ args: [resolve('.')], env: { ...process.env,
        LOWCORD_TEST: '1', LOWCORD_TEST_UPDATER: updater ? '1' : '0', LOWCORD_TEST_MEDIA_SOURCES: mediaSources ? '1' : '0', LOWCORD_TEST_URL: 'http://127.0.0.1:4319/electron', LOWCORD_TEST_DATA: dataDir } });
    app.process().stderr.on('data', data => {
        const message = data.toString();
        if (message.includes('[lowcord] Startup failed')||message.includes('[media-sources]')) console.error(message);
    });
    return app;
}

async function showForFullscreen(app) {
    await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        global.fullscreenTransitions = [];
        for (const event of ['enter-full-screen', 'leave-full-screen']) {
            window.on(event, () => global.fullscreenTransitions.push(event));
        }
        window.show();
    });
}

async function expectNativeFullscreen(app, fullscreen) {
    // isFullScreen() can change before macOS's animation finishes. Exiting
    // during that transition can leave the renderer waiting indefinitely.
    await expect.poll(() => app.evaluate(({ BrowserWindow }, fullscreen) =>
        BrowserWindow.getAllWindows()[0].isFullScreen() === fullscreen
        && global.fullscreenTransitions.includes(fullscreen ? 'enter-full-screen' : 'leave-full-screen'), fullscreen)).toBe(true);
}

test('eight media sources resolve linked originals in isolated sessions and send cookie-protected media with one click',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'orbitcord-sources-'));
    const app=await launch(dir,{mediaSources:true});
    try{
        const page=await app.firstWindow();await page.waitForLoadState('domcontentloaded');
        await page.evaluate(()=>{
            Lowcord.extensions.set('anonymiseFileNames',false);
            const original=Lowcord.store;
            Lowcord.store=name=>name==='SelectedChannelStore'?{getChannelId:()=> 'source-dm',addChangeListener(){},removeChangeListener(){}}
                :name==='ChannelStore'?{getChannel:()=>({id:'source-dm',type:1,name:'Fixture chat'})}:original(name);
            const composer=document.createElement('div');composer.className='channelTextArea_sources';
            const editor=document.createElement('textarea');editor.value='Keep my message';editor.setAttribute('aria-label','Source message');
            composer.append(editor);document.body.append(composer);
            window.sourcePosts=[];
            Object.defineProperty(Lowcord,'CloudUpload',{value:class{
                constructor({file},channel){window.sourceAttachment=file;this.filename=file.name;this.uploadedFilename='fixture/'+file.name;this.handlers={};window.sourceUploadChannel=channel;}
                on(type,fn){this.handlers[type]=fn;}async upload(){this.handlers.complete();}cancel(){}
            }});
            Object.defineProperty(Lowcord,'RestAPI',{value:{post:async request=>{sourcePosts.push(request);return{body:{id:'fixture-sent'}};}}});
        });
        await page.evaluate(()=>Lowcord.mediaSources.open());
        await expect.poll(()=>app.windows().some(p=>p.url().endsWith('/media-browser.html'))).toBe(true);
        const host=app.windows().find(p=>p.url().endsWith('/media-browser.html'));
        await expect(host.getByLabel('Media source')).toHaveValue('shorts');
        await expect(host.locator('#source option')).toHaveCount(8);
        await page.getByRole('button',{name:'Open site for browsing or login'}).click();
        await host.getByRole('button',{name:'Save page',exact:true}).click();
        await expect(host.getByRole('button',{name:'Unsave page',exact:true})).toBeVisible();
        await expect(host.locator('#saved option')).toHaveCount(2);
        const remote=async expression=>app.evaluate(async({webContents},expression)=>{
            const wc=webContents.getAllWebContents().find(w=>w.getURL().includes('/source-browser'));
            return wc?wc.executeJavaScript(expression):null;
        },expression);
        await expect.poll(()=>remote('document.readyState')).toBe('complete');
        expect(await remote('({node:typeof require,discord:typeof window.__LOWCORD_NATIVE__,toolbar:typeof window.mediaBrowser})'))
            .toEqual({node:'undefined',discord:'undefined',toolbar:'undefined'});
        await remote('document.querySelector("button").click()');
        await expect.poll(()=>remote('document.querySelector("#account").textContent')).toBe('Signed in');
        for(const id of ['gifreels','erome','sexcom','imagefap','xxxfollow','xxxtik','xfree']){
            await host.getByLabel('Media source').selectOption(id);
            await expect.poll(()=>remote('new URL(location.href).searchParams.get("source")')).toBe(id);
            await expect.poll(()=>remote('document.readyState')).toBe('complete');
            await expect.poll(()=>remote('document.querySelector("#account")?.textContent')).toBe('Signed out');
        }
        await host.getByLabel('Media source').selectOption('shorts');
        await expect.poll(()=>remote('new URL(location.href).searchParams.get("source")')).toBe('shorts');
        await expect.poll(()=>remote('document.querySelector("#account")?.textContent')).toBe('Signed in');
        await expect(host.locator('#saved option')).toHaveCount(2);
        await host.getByRole('button',{name:'Sign out',exact:true}).click();
        await expect.poll(()=>remote('document.querySelector("#account")?.textContent')).toBe('Signed out');
        await remote('document.querySelector("button").click()');
        await host.getByRole('button',{name:'Use this page in picker',exact:true}).click();
        const tile=page.getByRole('button',{name:'Send Open original fixture',exact:true});
        await expect(tile).toBeVisible();
        await expect.poll(()=>tile.locator('img').getAttribute('src')).toMatch(/^data:image\/jpeg;base64,/);
        await page.screenshot({path:'/tmp/lowcord-media-sources-picker.png'});
        await tile.click();
        await expect.poll(()=>page.evaluate(()=>sourcePosts.length)).toBe(1);
        await expect(page.getByLabel('Source message')).toHaveValue('Keep my message');
        const bytes=await readFile(resolve('tests/fixtures/media/sample.mp4'));
        expect(await page.evaluate(async()=>({type:sourceAttachment.type,size:sourceAttachment.size,header:Array.from(new Uint8Array(await sourceAttachment.slice(0,12).arrayBuffer()))})))
            .toEqual({type:'video/mp4',size:bytes.length,header:Array.from(bytes.subarray(0,12))});
        expect(await page.evaluate(()=>({channel:sourceUploadChannel,url:sourcePosts[0].url,nonce:sourcePosts[0].body.enforce_nonce})))
            .toEqual({channel:'source-dm',url:'/channels/source-dm/messages',nonce:true});
        await expect(tile).toBeDisabled();
        expect(await page.evaluate(()=>Lowcord.mediaSources.busy())).toBe(false);
        await expect(page.getByRole('dialog',{name:'Media sources picker'})).toBeVisible();
        await page.evaluate(()=>__LOWCORD_NATIVE__.mediaSources('command','navigate','http://127.0.0.1:4319/source-worker'));
        const workerTile=page.getByRole('button',{name:'Send Video',exact:true});await expect(workerTile).toBeVisible();await workerTile.click();
        await expect.poll(()=>page.evaluate(()=>sourcePosts.length)).toBe(2);
        expect(await page.evaluate(()=>sourceAttachment.type)).toBe('video/mp4');
    }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});

test('file-backed source blobs stream from their isolated page without exposing native APIs',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'orbitcord-blob-'));const app=await launch(dir);
    try{
        const page=await app.firstWindow();
        const url=await page.evaluate(async()=>{const response=await fetch('/media/sample.mp4');return URL.createObjectURL(await response.blob());});
        const result=await app.evaluate(async({BrowserWindow},url)=>{
            const wc=BrowserWindow.getAllWindows()[0].webContents;
            const {sourceBlobResponse}=process.mainModule.require(process.cwd()+'/electron/media-source-blob.cjs');
            const response=await sourceBlobResponse(wc,url,new AbortController().signal);
            const bytes=Buffer.from(await response.arrayBuffer());return{length:bytes.length,header:bytes.toString('ascii',4,8)};
        },url);
        expect(result).toEqual({length:(await readFile(resolve('tests/fixtures/media/sample.mp4'))).length,header:'ftyp'});
    }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});

test('cross-origin source downloads obey Chromium referrer policy instead of failing ERR_BLOCKED_BY_CLIENT',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'orbitcord-referrer-'));const app=await launch(dir);
    try{
        const result=await app.evaluate(async({session})=>{
            const {createSourceFiles}=process.mainModule.require(process.cwd()+'/electron/media-source-files.cjs');
            const files=createSourceFiles({validateURL:async value=>value});
            try{
                const result=await files.prepare(999,{url:'http://localhost:4319/media/sample.mp4',referer:'http://127.0.0.1:4319/source-browser?test=1',
                    source:'shorts',channelId:'test',limit:20_000_000,fetch:(url,init)=>session.defaultSession.fetch(url,init)});
                const bytes=await files.read(999,result.id,0);return{type:result.type,size:result.size,header:Buffer.from(bytes.subarray(4,8)).toString('ascii')};
            }finally{await files.close();}
        });
        expect(result).toMatchObject({type:'video/mp4',header:'ftyp'});expect(result.size).toBeGreaterThan(0);
    }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});

for (const method of ['chooser', 'overlay drop']) test(`automatic video attachments cross the sandbox in bounded chunks and produce a decodable MP4 in the native composer (${method})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orbitcord-compress-'));
    const app = await launch(dir);
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState('domcontentloaded');
        await page.evaluate(() => {
            Lowcord.extensions.set('anonymiseFileNames', false);
            const original = Lowcord.store;
            Lowcord.store = name => name === 'SelectedChannelStore' ? { getChannelId: () => 'fixture-dm' }
                : name === 'ChannelStore' ? { getChannel: () => ({ id: 'fixture-dm', type: 1 }) } : original(name);
            const composer = document.createElement('div'); composer.className = 'channelTextArea_compression';
            const input = document.createElement('input'); input.type = 'file'; input.setAttribute('aria-label', 'Compression input');
            input.addEventListener('change', () => { window.compressedFile = input.files[0]; });
            const editor = document.createElement('textarea');
            editor.addEventListener('paste', event => { if (event.clipboardData.files[0]) window.compressedFile = event.clipboardData.files[0]; });
            composer.append(input, editor); document.body.append(composer);
            const overlay = document.createElement('div'); overlay.className = 'uploadArea_compression';
            window.originalDropWarnings = 0; window.overlayCleaned = false;
            overlay.addEventListener('drop', event => {
                if ([...event.dataTransfer.files].some(file => file.size >= 20_000_000)) window.originalDropWarnings++;
            });
            document.body.append(overlay);
            document.body.addEventListener('drop', event => { if (!event.dataTransfer.files.length) { overlay.remove(); window.overlayCleaned = true; } });
        });
        expect(await page.evaluate(() => __LOWCORD_NATIVE__.videoCompression('begin', { size: 40_000_000, limit: 999 }))).toEqual({ error: 'invalid-input' });
        expect(await page.evaluate(() => __LOWCORD_NATIVE__.videoCompression('read', 'foreign-token', 0))).toEqual({ error: 'expired' });
        expect(await page.evaluate(() => __LOWCORD_NATIVE__.videoCompression('__proto__'))).toEqual({ error: 'invalid-action' });
        if (method === 'chooser') {
            const source = await readFile(resolve('tests/fixtures/media/sample.mp4'));
            const padded = Buffer.alloc(20_000_001); source.copy(padded);
            await page.getByLabel('Compression input').setInputFiles({ name: 'SPOILER_hike.mov', mimeType: 'video/quicktime', buffer: padded });
        } else {
            await page.evaluate(async () => {
                const source = new Uint8Array(await (await fetch('/media/sample.mp4')).arrayBuffer());
                const padded = new Uint8Array(20_000_001); padded.set(source);
                const data = new DataTransfer(); data.items.add(new File([padded], 'SPOILER_hike.mov', { type: 'video/quicktime' }));
                document.querySelector('.uploadArea_compression').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
            });
            expect(await page.evaluate(() => window.overlayCleaned)).toBe(true);
            expect(await page.evaluate(() => window.originalDropWarnings)).toBe(0);
        }
        await expect.poll(() => page.evaluate(() => window.compressedFile?.size ?? 0), { timeout: 30_000 }).toBeGreaterThan(0);
        const info = await page.evaluate(async () => {
            const file = window.compressedFile;
            const video = document.createElement('video'); video.id = 'compressed-preview'; video.muted = true; video.controls = true;
            video.src = URL.createObjectURL(file); document.body.append(video);
            const loaded = new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error('Invalid MP4')); });
            await loaded;
            return { size: file.size, type: file.type, name: file.name, width: video.videoWidth, height: video.videoHeight };
        });
        expect(info).toMatchObject({ type: 'video/mp4', name: 'SPOILER_hike.mp4' });
        expect(info.size).toBeLessThan(20_000_000); expect(info.width).toBeGreaterThan(0); expect(info.height).toBeGreaterThan(0);
        expect(await page.evaluate(() => Lowcord.videoCompression.busy())).toBe(false);
        // A foreign frame has no bridge or arbitrary-path/file access.
        const frame = page.frames().find(frame => frame !== page.mainFrame());
        if (frame) expect(await frame.evaluate(() => typeof window.__LOWCORD_NATIVE__)).toBe('undefined');
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Windows icon resources contain real images at every taskbar size and survive restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orbitcord-icons-'));
    let app = await launch(dir);
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState('domcontentloaded');
        const resources = await app.evaluate(({ nativeImage }, { dir, root }) => {
            const { windowsIconPath } = process.mainModule.require(`${root}/electron/windows-icon.cjs`);
            const { readFileSync } = process.mainModule.require('node:fs');
            return ['default', 'candy', 'champagne', 'graphite', 'midnight', 'sun', 'ember', 'fjord', 'marine', 'scarlet'].map(id => {
                const source = `${root}/src-tauri/icons/app/${id}.png`;
                const path = windowsIconPath(source, dir, nativeImage);
                const ico = readFileSync(path);
                if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error('Invalid ICO header');
                const original = nativeImage.createFromPath(source);
                const sizes = [];
                for (let index = 0; index < ico.readUInt16LE(4); index++) {
                    const entry = 6 + index * 16;
                    const size = ico[entry] || 256;
                    const offset = ico.readUInt32LE(entry + 12);
                    const length = ico.readUInt32LE(entry + 8);
                    const frame = ico.subarray(offset, offset + length);
                    const maskStride = Math.ceil(size / 32) * 4;
                    if (frame.readUInt32LE(0) !== 40 || frame.readInt32LE(4) !== size || frame.readInt32LE(8) !== size * 2
                        || frame.readUInt16LE(14) !== 32 || length !== 40 + size * size * 4 + maskStride * size) {
                        throw new Error(`Invalid Windows DIB frame: ${id} at ${size}px`);
                    }
                    const expected = original.resize({ width: size, height: size, quality: 'best' }).toBitmap();
                    for (let y = 0; y < size; y++) {
                        for (let x = 0; x < size; x++) {
                            const pixel = (y * size + x) * 4;
                            const dibPixel = 40 + ((size - y - 1) * size + x) * 4;
                            const alpha = frame[dibPixel + 3];
                            if (alpha !== expected[pixel + 3]) throw new Error(`Incorrect icon alpha: ${id}`);
                            for (let channel = 0; channel < 3; channel++) {
                                if (Math.abs(Math.round(frame[dibPixel + channel] * alpha / 255) - expected[pixel + channel]) > 1) {
                                    throw new Error(`Incorrect icon color: ${id} at ${size}px`);
                                }
                            }
                            const masked = !!(frame[40 + size * size * 4 + (size - y - 1) * maskStride + (x >> 3)] & (0x80 >> (x & 7)));
                            if (masked !== (alpha === 0)) throw new Error(`Incorrect icon transparency mask: ${id}`);
                        }
                    }
                    sizes.push(size);
                }
                // Cached files must be usable without decoding the source again.
                const cached = windowsIconPath(source, dir, { createFromBuffer() { throw new Error('Cache miss'); } });
                return { id, path, cached, sizes };
            });
        }, { dir, root: resolve('.') });
        expect(new Set(resources.map(resource => resource.path)).size).toBe(10);
        for (const resource of resources) {
            expect(resource.cached).toBe(resource.path);
            expect(resource.sizes).toEqual([16, 20, 24, 32, 40, 48, 64, 128, 256]);
        }
        await page.evaluate(() => window.__LOWCORD_NATIVE__.appIcon('graphite'));
        expect(JSON.parse(await readFile(join(dir, 'app-icon.json'), 'utf8'))).toEqual({ icon: 'graphite' });
        if (process.platform === 'win32') {
            for (const resource of resources) {
                expect(await app.evaluate(async ({ app, nativeImage }, path) =>
                    (await app.getFileIcon(path)).isEmpty() || nativeImage.createFromPath(path).isEmpty(), resource.path)).toBe(false);
            }
            await app.evaluate(({ BrowserWindow }) => {
                const window = BrowserWindow.getAllWindows()[0];
                window.show();
                global.iconTaskbarRefreshes = [];
                const skip = window.setSkipTaskbar.bind(window);
                window.setSkipTaskbar = value => { global.iconTaskbarRefreshes.push(value); skip(value); };
            });
            for (const id of ['midnight', 'candy', 'default', 'sun', 'champagne', 'graphite', 'midnight', 'graphite']) {
                await page.evaluate(id => window.__LOWCORD_NATIVE__.appIcon(id), id);
                expect(await page.evaluate(() => window.__LOWCORD_NATIVE__.appIcon())).toBe(id);
            }
            expect(await app.evaluate(() => global.iconTaskbarRefreshes)).toEqual(Array.from({ length: 8 }, () => [true, false]).flat());
            const pin = await app.evaluate(async ({ shell }, { dir, root, icon }) => {
                const { mkdirSync } = process.mainModule.require('node:fs');
                const { join } = process.mainModule.require('node:path');
                const { updateShortcutIcons } = process.mainModule.require(`${root}/electron/windows-icon.cjs`);
                const directory = join(dir, 'test-pins');
                mkdirSync(directory);
                const path = join(directory, 'OrbitCord.lnk');
                if (!shell.writeShortcutLink(path, 'create', { target: process.execPath,
                    args: '--test-argument', description: 'Test pin', icon: process.execPath, iconIndex: 0 })) {
                    throw new Error('Could not create test pin');
                }
                await updateShortcutIcons(directory, process.execPath, 'dev.lowcord.app', icon, shell);
                return shell.readShortcutLink(path);
            }, { dir, root: resolve('.'), icon: resources[3].path });
            expect(pin.icon).toBe(resources[3].path);
            expect(pin.iconIndex).toBe(0);
            expect(pin.args).toBe('--test-argument');
            expect(pin.description).toBe('Test pin');
            expect(pin.appUserModelId).toBe('dev.lowcord.app');
        }
        await app.close();
        app = await launch(dir);
        const restarted = await app.firstWindow();
        await restarted.waitForLoadState('domcontentloaded');
        expect(await restarted.evaluate(() => window.__LOWCORD_NATIVE__.appIcon())).toBe('graphite');
        await expect(restarted.evaluate(() => window.__LOWCORD_NATIVE__.appIcon('../invalid'))).rejects.toThrow('Unknown icon');
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('native picture-in-picture opens from chat videos, switches sources and exits without a second player', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lowcord-pip-'));
    const app = await launch(dir);
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState('domcontentloaded');
        await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].show(); });
        await page.evaluate(() => {
            for (const id of ['video', 'webm']) {
                const video = document.getElementById(id);
                const row = document.createElement('section'); row.id = `chat-messages-${id}`;
                video.before(row); row.append(video); video.muted = true; video.loop = true;
            }
        });
        await page.evaluate(async () => { const video = document.getElementById('video'); await video.play(); video.disablePictureInPicture = true; });
        await page.locator('#video').hover();
        await page.getByRole('button', { name: 'Picture-in-picture', exact: true }).click();
        await expect.poll(() => page.evaluate(() => document.pictureInPictureElement?.id)).toBe('video');
        await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].minimize(); });
        expect(await page.evaluate(() => document.pictureInPictureElement?.id)).toBe('video');
        await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.restore(); window.focus(); });
        expect(await page.locator('#video').evaluate(video => video.disablePictureInPicture)).toBe(false);
        await expect.poll(() => page.locator('#video').evaluate(video => video.currentTime)).toBeGreaterThan(.1);
        await page.evaluate(() => document.getElementById('video').pause());
        expect(await page.evaluate(() => window.__lowcordBusy())).toBe(true);
        await page.locator('#video').hover();
        await expect(page.getByRole('button', { name: 'Exit picture-in-picture', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Exit picture-in-picture', exact: true }).click();
        await expect.poll(() => page.evaluate(() => document.pictureInPictureElement?.id ?? null)).toBeNull();
        expect(await page.locator('#video').evaluate(video => video.disablePictureInPicture)).toBe(true);
        await page.evaluate(() => document.getElementById('webm').play());
        await page.locator('#webm').hover();
        await page.keyboard.press('Alt+p');
        await expect.poll(() => page.evaluate(() => document.pictureInPictureElement?.id)).toBe('webm');
        await page.evaluate(() => Lowcord.extensions.set('pictureInPicture', false));
        await expect.poll(() => page.evaluate(() => document.pictureInPictureElement?.id ?? null)).toBeNull();
        await expect(page.locator('.lowcord-pip-button')).toHaveCount(0);
        expect(await page.locator('video').count()).toBe(3);
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('embedded video context menu requests native PiP inside its own frame', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lowcord-frame-pip-'));
    const app = await launch(dir);
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState('domcontentloaded');
        await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].show(); });
        const child = page.frames().find(frame => frame.url().endsWith('/electron-child'));
        await expect.poll(() => page.frames().some(frame => frame.url().endsWith('/electron-child'))).toBe(true);
        const frame = child || page.frames().find(frame => frame.url().endsWith('/electron-child'));
        const source = await frame.evaluate(async () => {
            const video = document.createElement('video'); video.id = 'embedded-video';
            video.src = '/media/sample.mp4'; video.controls = true; video.muted = true; video.loop = true;
            document.body.append(video); await video.play(); video.disablePictureInPicture = true;
            return video.currentSrc;
        });
        await app.evaluate(({ BrowserWindow, Menu }, source) => {
            const contents = BrowserWindow.getAllWindows()[0].webContents;
            const frame = contents.mainFrame.framesInSubtree.find(frame => frame.url.endsWith('/electron-child'));
            global.pipMenu = null;
            global.originalPipMenu = Menu.buildFromTemplate;
            Menu.buildFromTemplate = items => { global.pipMenu = items; return { popup() {} }; };
            contents.emit('context-menu', {}, { mediaType: 'video', frame, pageURL: contents.getURL(), srcURL: source,
                mediaFlags: { isShowingPictureInPicture: false } });
        }, source);
        await expect.poll(() => app.evaluate(() => global.pipMenu?.map(item => item.label))).toEqual(['Download video…', 'Picture-in-picture']);
        await app.evaluate(({ Menu }) => { Menu.buildFromTemplate = global.originalPipMenu; global.pipMenu.find(item => item.label === 'Picture-in-picture').click(); });
        await expect.poll(() => frame.evaluate(() => document.pictureInPictureElement?.id)).toBe('embedded-video');
        expect(await frame.evaluate(() => typeof window.__LOWCORD_NATIVE__)).toBe('undefined');
        await frame.evaluate(() => document.exitPictureInPicture());
        expect(await frame.evaluate(() => document.querySelector('video').disablePictureInPicture)).toBe(true);
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('linked video downloads save original bytes, support cancellation and reject non-media schemes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lowcord-video-download-'));
    const app = await launch(dir);
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState('domcontentloaded');
        const path = join(dir, 'saved-video.mp4');
        await app.evaluate(({ session }, path) => {
            session.defaultSession.once('will-download', (_event, item) => {
                global.videoDownloadUrl = item.getURL();
                item.setSavePath(path);
                item.once('done', (_event, state) => { global.videoDownloadState = state; });
            });
        }, path);
        await page.evaluate(() => window.__LOWCORD_NATIVE__.downloadMedia(`${location.origin}/media/sample.mp4?signature=a%2Bb&ex=123`));
        await expect.poll(() => app.evaluate(() => global.videoDownloadState)).toBe('completed');
        expect(await app.evaluate(() => global.videoDownloadUrl)).toBe('http://127.0.0.1:4319/media/sample.mp4?signature=a%2Bb&ex=123');
        expect(await readFile(path)).toEqual(await readFile('tests/fixtures/media/sample.mp4'));
        await app.evaluate(({ session }) => {
            global.videoDownloadState = undefined;
            session.defaultSession.once('will-download', (_event, item) => {
                item.once('done', (_event, state) => { global.videoDownloadState = state; }); item.cancel();
            });
        });
        await page.evaluate(() => window.__LOWCORD_NATIVE__.downloadMedia(`${location.origin}/media/sample.mp4`));
        await expect.poll(() => app.evaluate(() => global.videoDownloadState)).toBe('cancelled');
        const cachedPath = join(dir, 'cached-video.mp4');
        await app.evaluate(async ({ session }, { path, bytes }) => {
            const ses = session.defaultSession;
            await ses.protocol.unhandle('lowcord-media');
            ses.protocol.handle('lowcord-media', () => new Response(Buffer.from(bytes, 'base64'), { headers: { 'content-type': 'video/mp4' } }));
            global.videoDownloadState = undefined;
            ses.once('will-download', (_event, item) => {
                item.setSavePath(path);
                item.once('done', (_event, state) => { global.videoDownloadState = state; });
            });
        }, { path: cachedPath, bytes: (await readFile('tests/fixtures/media/sample.mp4')).toString('base64') });
        await page.evaluate(() => window.__LOWCORD_NATIVE__.downloadMedia('lowcord-media://media/0123456789abcdef01234567'));
        await expect.poll(() => app.evaluate(() => global.videoDownloadState)).toBe('completed');
        expect(await readFile(cachedPath)).toEqual(await readFile('tests/fixtures/media/sample.mp4'));
        for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,test', 'blob:https://discord.com/mse', 'https://example.com/video.m3u8', 'https://example.com/video.mpd', 'https://user:pass@example.com/clip.mp4', 'lowcord-media://anything/token']) {
            await expect(page.evaluate(url => window.__LOWCORD_NATIVE__.downloadMedia(url), url)).rejects.toThrow('downloadable media file');
        }
        await page.evaluate(() => {
            const viewer = document.getElementById('image-viewer'); viewer.hidden = false;
            const video = document.createElement('video'); video.id = 'viewer-clip'; video.src = '/media/sample.mp4'; video.controls = true;
            video.width = 160; video.height = 90; viewer.append(video);
        });
        await app.evaluate(({ BrowserWindow, Menu }) => {
            BrowserWindow.getAllWindows()[0].show();
            Menu.prototype.popup = function () { global.videoMenu = this; };
        });
        await page.locator('#viewer-clip').click({ button: 'right' });
        await expect.poll(() => app.evaluate(() => global.videoMenu?.items.map(item => item.label))).toEqual(['Download video…']);
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('real Electron decodes MP4/H.264, AAC, WebM and GIF loops inline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lowcord-electron-'));
    const app = await launch(dir);
    try {
        const page = await app.firstWindow();
        await page.waitForFunction(() => window.earlyInjection);
        const browser = await page.evaluate(() => ({
            userAgent: navigator.userAgent,
            getUserMedia: typeof navigator.mediaDevices?.getUserMedia,
            peerConnection: typeof RTCPeerConnection,
        }));
        expect(browser.userAgent).toContain('Chrome/');
        expect(browser.userAgent).not.toMatch(/(?:Electron|Lowcord|Datcord|OrbitCord)\//i);
        expect(browser.getUserMedia).toBe('function');
        expect(browser.peerConnection).toBe('function');
        expect(await page.evaluate(() => window.earlyInjection)).toEqual({ initialized: true, hooked: true,
            extensions: await page.evaluate(() => window.Lowcord.extensions.catalog.length), fetchHooked: true });
        expect(await page.evaluate(() => ({ node: typeof window.require, process: typeof window.process, bridge: Object.keys(window.__LOWCORD_NATIVE__) })))
            .toEqual({ node: 'undefined', process: 'undefined', bridge: ['notify', 'setBadge', 'log', 'openExternal', 'updateStatus', 'checkForUpdates', 'downloadUpdate', 'installUpdate', 'onUpdateStatus', 'appIcon', 'setEmbedPreferences', 'background', 'resolveSocialLink', 'socialPost', 'socialVideo', 'socialMedia', 'redgifsSearch', 'redgifsPrepare', 'redgifsCancel', 'redgifsResolve', 'redgifsRelease', 'reddit', 'videoCompression', 'mediaSources', 'onMediaSource', 'captureRegion', 'copyImage', 'saveImage', 'downloadMedia', 'reportAccount', 'accounts', 'onAccountsChanged'] });
        expect(await page.evaluate(() => window.__LOWCORD_NATIVE__.redgifsSearch('fixture', -1))).toEqual({ error: 'invalid-search' });
        expect(await page.evaluate(() => window.__LOWCORD_NATIVE__.redgifsPrepare('not-a-token', 20_000_000))).toEqual({ error: 'expired' });
        await page.evaluate(() => window.__LOWCORD_NATIVE__.redgifsCancel());
        // Card media loads like <img>/<video> (no CORS) from the privileged scheme;
        // an unhandled scheme would reject instead of answering.
        expect(await page.evaluate(() => fetch('lowcord-media://media/0123456789abcdef01234567', { mode: 'no-cors' }).then(r => r.type))).toBe('opaque');
        for (const id of ['video', 'audio', 'webm']) {
            await page.evaluate(async id => {
                const media = document.getElementById(id);
                media.muted = true;
                await media.play();
            }, id);
            await expect.poll(() => page.$eval(`#${id}`, media => media.currentTime)).toBeGreaterThan(0.15);
            expect(await page.$eval(`#${id}`, media => media.error)).toBeNull();
        }
        await expect.poll(() => page.$eval('#gif', media => media.currentTime)).toBeGreaterThan(0.1);
        expect(await page.locator('.lowcord-media-player, .lowcord-video-play, .lowcord-gif').count()).toBe(0);
        await page.evaluate(() => document.getElementById('video').pause());
        expect(await page.$eval('#video', media => media.paused)).toBe(true);
        await page.evaluate(() => { document.getElementById('video').currentTime = 0.8; });
        await expect.poll(() => page.$eval('#video', media => media.currentTime)).toBeCloseTo(0.8, 1);
        expect(app.windows()).toHaveLength(1);
        const frame = page.frame({ url: 'http://127.0.0.1:4319/electron-child' });
        expect(await frame.evaluate(() => typeof window.__LOWCORD_NATIVE__)).toBe('undefined');
        expect(await page.evaluate(async () => {
            try { await window.__LOWCORD_NATIVE__.openExternal('file:///tmp/test'); return false; } catch { return true; }
        })).toBe(true);
        await page.evaluate(() => window.__LOWCORD_NATIVE__.setBadge(2));
        expect(await app.evaluate(({ app }) => app.getBadgeCount())).toBe(2);
        expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox)).toBe(true);
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('RedGIFs opaque preview proxy and prepared file cross the sandbox bridge in real Electron', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lowcord-redgifs-electron-'));
    const app = await launch(dir);
    try {
        const page = await app.firstWindow();
        await page.waitForFunction(() => window.earlyInjection);
        await page.waitForLoadState('load');
        await app.evaluate(async ({ BrowserWindow, ipcMain }, root) => {
            const { readFile } = process.mainModule.require('node:fs/promises');
            const { createRedgifs } = process.mainModule.require(`${root}/electron/redgifs.cjs`);
            const bytes = await readFile(`${root}/tests/fixtures/media/sample.mp4`);
            const service = global.redgifsTestService = createRedgifs({ fetchPage: async url => {
                if (url.endsWith('/auth/temporary')) return new Response(JSON.stringify({ token: 'fixture' }));
                if (url.includes('/niches/search?')) return new Response(JSON.stringify({ pages: 1, niches: [
                    { id: 'neutral-animation', name: 'Neutral animation', gifs: 12, subscribers: 34 },
                ] }));
                if (url.includes('/creators/search?')) return new Response(JSON.stringify({ pages: 1, items: [
                    { username: 'neutral_creator', name: 'Neutral Creator', publishedGifs: 12, followers: 34 },
                ] }));
                if (url.endsWith('/gifs/NeutralFixture')) return new Response(JSON.stringify({ gif:
                    { id: 'NeutralFixture', type: 1, urls: { hd: 'https://media.redgifs.com/NeutralFixture.mp4' } },
                }));
                if (url.includes('/gifs/search?') || url.includes('/feeds/trending/popular?')
                    || url.includes('/users/neutral_creator/search?') || url.includes('/niches/neutral-animation/gifs?')) return new Response(JSON.stringify({ pages: 1, gifs: [
                    { id: 'NeutralFixture', type: 1, urls: { hd: 'https://media.redgifs.com/NeutralFixture.mp4' } },
                ] }));
                return new Response(bytes, { headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) } });
            } });
            // Replace handlers only in this isolated test process. Production
            // trusted-sender checks are exercised by the decoding test above.
            for (const method of ['search', 'prepare', 'cancel', 'resolve', 'release']) {
                const name = `lowcord:redgifs-${method}`;
                ipcMain.removeHandler(name);
                ipcMain.handle(name, (event, ...args) => service[method](event.sender.id, ...args));
            }
            const ses = BrowserWindow.getAllWindows()[0].webContents.session;
            ses.protocol.unhandle('lowcord-media');
            ses.protocol.handle('lowcord-media', async request => {
                const response = await service.serve(request);
                global.redgifsTestTrace = { method: request.method, range: request.headers.get('range'), status: response.status,
                    headers: Object.fromEntries(response.headers) };
                return response;
            });
        }, resolve('.'));
        // Replacing a protocol in a fixture requires a fresh document because
        // Chromium caches its loader factory at navigation time.
        await page.reload();
        const result = await page.evaluate(async () => {
            const { items } = await __LOWCORD_NATIVE__.redgifsSearch('neutral', 1);
            const prepared = await __LOWCORD_NATIVE__.redgifsPrepare(items[0].key, 20_000_000);
            const niches = await __LOWCORD_NATIVE__.redgifsSearch('animation', 1, { mode: 'niches' });
            const feed = await __LOWCORD_NATIVE__.redgifsSearch('', 1, { mode: 'videos', nicheId: niches.niches[0].id });
            const trending = await __LOWCORD_NATIVE__.redgifsSearch('', 1);
            const explore = await __LOWCORD_NATIVE__.redgifsSearch('', 1, { mode: 'explore' });
            const creators = await __LOWCORD_NATIVE__.redgifsSearch('', 1, { mode: 'creators' });
            const creatorFeed = await __LOWCORD_NATIVE__.redgifsSearch('', 1, { mode: 'creators', creator: creators.creators[0].id });
            const favorite = await __LOWCORD_NATIVE__.redgifsResolve(items[0].id);
            const preparedData = new Uint8Array(await (await fetch(prepared.url, { credentials: 'omit' })).arrayBuffer());
            await __LOWCORD_NATIVE__.redgifsRelease(prepared.handle);
            const player = document.createElement('video');
            player.id = 'redgifs-proxy-test'; player.src = items[0].preview; player.muted = true;
            document.body.append(player);
            let playbackError;
            try { await player.play(); } catch (error) { playbackError = error.message; }
            return { type: prepared.type, name: prepared.name, bytes: preparedData.byteLength,
                signature: String.fromCharCode(...preparedData.slice(4, 8)), preview: items[0].preview, playbackError,
                nicheCount: niches.niches.length, nicheFeedCount: feed.items.length,
                trendingCount: trending.items.length, exploreCount: explore.items.length, creatorCount: creators.creators.length,
                creatorFeedCount: creatorFeed.items.length, freshFavorite: favorite.key !== items[0].key };
        });
        expect({ error: result.playbackError, protocol: await app.evaluate(() => global.redgifsTestTrace) }).toEqual({ error: undefined, protocol: expect.objectContaining({ status: 200 }) });
        expect(result).toMatchObject({ type: 'video/mp4', name: 'redgifs-NeutralFixture.mp4', signature: 'ftyp', nicheCount: 1, nicheFeedCount: 1,
            trendingCount: 1, exploreCount: 1, creatorCount: 1, creatorFeedCount: 1, freshFavorite: true });
        expect(result.bytes).toBeGreaterThan(1000);
        expect(result.preview).toMatch(/^lowcord-media:\/\/redgifs\//);
        await expect.poll(() => page.$eval('#redgifs-proxy-test', video => video.currentTime)).toBeGreaterThan(0.1);
        expect(await page.$eval('#redgifs-proxy-test', video => video.error)).toBeNull();
        await page.evaluate(() => __LOWCORD_NATIVE__.redgifsCancel());
        await app.evaluate(() => global.redgifsTestService.close());
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('attachment video keeps playing through fullscreen and returns inline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lowcord-fullscreen-'));
    const app = await launch(dir);
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState('load');
        await showForFullscreen(app);
        await page.evaluate(() => {
            const video = document.getElementById('video');
            video.muted = true; video.loop = true;
            const button = document.createElement('button'); button.textContent = 'Fullscreen video';
            button.onclick = () => video.requestFullscreen().catch(error => { window.fullscreenError = error.message; });
            document.body.prepend(button);
        });
        await page.evaluate(() => document.getElementById('video').play());
        await page.getByRole('button', { name: 'Fullscreen video' }).click();
        await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id ?? window.fullscreenError)).toBe('video');
        await expectNativeFullscreen(app, true);
        await expect.poll(() => page.$eval('#video', video => video.webkitVideoDecodedByteCount)).toBeGreaterThan(0);
        expect(await page.$eval('#video', video => ({ error: video.error, paused: video.paused }))).toEqual({ error: null, paused: false });
        const frames = await page.$eval('#video', video => video.getVideoPlaybackQuality().totalVideoFrames);
        await expect.poll(() => page.$eval('#video', video => video.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(frames);
        await page.evaluate(() => document.exitFullscreen());
        await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
        await expectNativeFullscreen(app, false);
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('embedded video can play and enter fullscreen from its own button', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lowcord-embed-fullscreen-'));
    const app = await launch(dir);
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState('load');
        await showForFullscreen(app);
        const video = (await readFile('tests/fixtures/media/sample.mp4')).toString('base64');
        const url = 'https://www.youtube.com/embed/fullscreen-fixture';
        await page.route(url, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
            <video id="player" controls muted loop width="160" height="90" src="data:video/mp4;base64,${video}"></video>
            <button onclick="document.getElementById('player').requestFullscreen().catch(error => window.fullscreenError = error.name)">Fullscreen embed</button>` }));
        await page.evaluate(url => {
            const frame = document.createElement('iframe'); frame.src = url;
            frame.allow = 'autoplay; fullscreen; camera; microphone'; document.body.prepend(frame);
        }, url);
        await expect.poll(() => page.frames().some(frame => frame.url() === url)).toBe(true);
        const frame = page.frame({ url });
        expect(await frame.evaluate(async () => (await navigator.permissions.query({ name: 'camera' })).state)).toBe('denied');
        expect(await frame.evaluate(async () => (await navigator.permissions.query({ name: 'microphone' })).state)).toBe('denied');
        await frame.locator('#player').evaluate(video => video.play());
        await expect.poll(() => frame.locator('#player').evaluate(video => video.currentTime)).toBeGreaterThan(.15);
        await frame.getByRole('button', { name: 'Fullscreen embed' }).click();
        await expect.poll(() => frame.evaluate(() => document.fullscreenElement?.id ?? window.fullscreenError)).toBe('player');
        await expectNativeFullscreen(app, true);
        expect(await frame.locator('#player').evaluate(video => ({ error: video.error, paused: video.paused }))).toEqual({ error: null, paused: false });
        const frames = await frame.locator('#player').evaluate(video => video.getVideoPlaybackQuality().totalVideoFrames);
        await expect.poll(() => frame.locator('#player').evaluate(video => video.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(frames);
        await frame.evaluate(() => document.exitFullscreen());
        await expect.poll(() => frame.evaluate(() => document.fullscreenElement === null)).toBe(true);
        await expectNativeFullscreen(app, false);
        // An app permission grant must not bypass Discord's iframe delegation.
        await page.evaluate(url => {
            const iframe = document.createElement('iframe'); iframe.name = 'no-fullscreen';
            iframe.src = url; iframe.allow = 'autoplay'; document.body.prepend(iframe);
        }, url);
        await expect.poll(() => page.frame({ name: 'no-fullscreen' })?.url()).toBe(url);
        const blocked = page.frame({ name: 'no-fullscreen' });
        await blocked.getByRole('button', { name: 'Fullscreen embed' }).click();
        await expect.poll(() => blocked.evaluate(() => window.fullscreenError)).toBe('TypeError');
        expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
        await expectNativeFullscreen(app, false);
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Rust saves window state across Electron restarts and quits with its parent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lowcord-state-'));
    let app = await launch(dir);
    try {
        await (await app.firstWindow()).waitForLoadState('domcontentloaded');
        const backendPid = await app.evaluate(() => process._getActiveHandles().find(handle => handle.constructor.name === 'ChildProcess')?.pid);
        expect(backendPid).toBeGreaterThan(0);
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 900, height: 650 }));
        await app.close();
        await expect.poll(() => {
            try { process.kill(backendPid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
        }).toBe(false);
        const state = JSON.parse(await readFile(join(dir, 'window-state.json'), 'utf8'));
        expect(state.width).toBe(900);
        expect(state.height).toBe(650);
        app = await launch(dir);
        await (await app.firstWindow()).waitForLoadState('domcontentloaded');
        expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds().width)).toBe(900);
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('account windows keep separate logins, badges and window state across restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lowcord-accounts-'));
    let app = await launch(dir);
    try {
        const page = await app.firstWindow();
        await page.waitForFunction(() => window.earlyInjection);
        await page.evaluate(() => localStorage.setItem('lowcord-test-login', 'main'));
        expect(await page.evaluate(() => window.__LOWCORD_NATIVE__.accounts()))
            .toEqual([{ id: 'main', name: 'Main account', main: true, current: true, open: true }]);
        const [second] = await Promise.all([app.waitForEvent('window'), page.evaluate(() => window.__LOWCORD_NATIVE__.accounts('new'))]);
        await second.waitForFunction(() => window.earlyInjection);
        expect(await second.evaluate(() => localStorage.getItem('lowcord-test-login'))).toBeNull();
        await second.evaluate(() => localStorage.setItem('lowcord-test-login', 'second'));
        await page.evaluate(() => window.__LOWCORD_NATIVE__.reportAccount('main-user'));
        await second.evaluate(() => window.__LOWCORD_NATIVE__.reportAccount('second-user'));
        expect(JSON.parse(await readFile(join(dir, 'accounts.json'), 'utf8')))
            .toEqual({ accounts: [{ id: 'main', label: 'main-user' }, { id: 'account-1', label: 'second-user' }] });
        expect(await app.evaluate(({ BrowserWindow, session }) => BrowserWindow.getAllWindows().map(window => ({
            title: window.getTitle(), main: window.webContents.session === session.defaultSession,
            partition: window.webContents.session === session.fromPartition('persist:account-1') })).sort((a, b) => a.title.localeCompare(b.title))))
            .toEqual([{ title: 'OrbitCord — main-user', main: true, partition: false }, { title: 'OrbitCord — second-user', main: false, partition: true }]);
        // The badge adds up every account; a closed account window drops out.
        await page.evaluate(() => window.__LOWCORD_NATIVE__.setBadge(2));
        await second.evaluate(() => window.__LOWCORD_NATIVE__.setBadge(3));
        expect(await app.evaluate(({ app }) => app.getBadgeCount())).toBe(5);
        await app.evaluate(({ BrowserWindow, session }) => BrowserWindow.getAllWindows()
            .find(window => window.webContents.session === session.fromPartition('persist:account-1')).setBounds({ width: 900, height: 650 }));
        await expect.poll(async () => {
            try { return JSON.parse(await readFile(join(dir, 'window-state-account-1.json'), 'utf8')).width; } catch { return 0; }
        }).toBe(900);
        await app.evaluate(({ BrowserWindow, session }) => BrowserWindow.getAllWindows()
            .find(window => window.webContents.session === session.fromPartition('persist:account-1')).close());
        await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
        expect(await app.evaluate(({ app }) => app.getBadgeCount())).toBe(2);
        expect(await page.evaluate(() => window.__LOWCORD_NATIVE__.accounts())).toEqual([
            { id: 'main', name: 'main-user', main: true, current: true, open: true },
            { id: 'account-1', name: 'second-user', main: false, current: false, open: false }]);
    } finally { await app.close(); }
    app = await launch(dir);
    try {
        // Extra accounts reopen only on demand, still logged in.
        const page = await app.firstWindow();
        await page.waitForFunction(() => window.earlyInjection);
        expect(app.windows()).toHaveLength(1);
        expect(await page.evaluate(() => localStorage.getItem('lowcord-test-login'))).toBe('main');
        const [second] = await Promise.all([app.waitForEvent('window'), page.evaluate(() => window.__LOWCORD_NATIVE__.accounts('open-named', { name: 'second-user' }))]);
        await second.waitForFunction(() => window.earlyInjection);
        expect(await second.evaluate(() => localStorage.getItem('lowcord-test-login'))).toBe('second');
        expect(await app.evaluate(({ BrowserWindow, session }) => BrowserWindow.getAllWindows()
            .find(window => window.webContents.session === session.fromPartition('persist:account-1')).getBounds().width)).toBe(900);
        // Picking an account OrbitCord doesn't know yet opens a new, named window.
        const [third] = await Promise.all([app.waitForEvent('window'), page.evaluate(() => window.__LOWCORD_NATIVE__.accounts('open-named', { name: 'third-user' }))]);
        await third.waitForFunction(() => window.earlyInjection);
        expect((await page.evaluate(() => window.__LOWCORD_NATIVE__.accounts())).map(account => account.name))
            .toEqual(['main-user', 'second-user', 'third-user']);
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('file-backed Reddit playback decodes both tracks, seeks, and cleans up', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lowcord-file-playback-'));
    const app = await launch(dir);
    try {
        const page = await app.firstWindow(); await page.waitForLoadState('load');
        const src = await app.evaluate(async ({ BrowserWindow }, { root, dir }) => {
            const { createRedditFixture } = process.mainModule.require(`${root}/tests/fixtures/reddit-playback.cjs`);
            const { createSocialPosts } = process.mainModule.require(`${root}/electron/social-posts.cjs`);
            global.playbackTest = createSocialPosts(createRedditFixture(root).fetchPage, { directory: dir });
            const protocol = BrowserWindow.getAllWindows()[0].webContents.session.protocol;
            protocol.unhandle('lowcord-media');
            protocol.handle('lowcord-media', request => global.playbackTest.serve(request));
            return (await global.playbackTest.get('https://www.reddit.com/comments/abc/')).media[0].src;
        }, { root: resolve('.'), dir });
        // Chromium keeps protocol loader factories for the loaded document.
        await page.reload();
        await page.evaluate(async src => {
            const video = document.createElement('video'); video.id = 'disk-video'; video.muted = true;
            document.body.append(video); video.src = src; await video.play();
        }, src);
        await expect.poll(() => page.$eval('#disk-video', video => video.currentTime)).toBeGreaterThan(.2);
        expect(await page.$eval('#disk-video', video => ({ width: video.videoWidth, duration: video.duration,
            audio: video.webkitAudioDecodedByteCount > 0, video: video.webkitVideoDecodedByteCount > 0 })))
            .toMatchObject({ width: 160, audio: true, video: true });
        expect(await page.$eval('#disk-video', video => video.duration)).toBeCloseTo(2, 1);
        await page.$eval('#disk-video', video => { video.pause(); video.currentTime = 1.5; });
        await expect.poll(() => page.$eval('#disk-video', video => video.seeking)).toBe(false);
        expect(await page.$eval('#disk-video', video => video.error)).toBeNull();
        await app.evaluate(async () => { await global.playbackTest.close(); });
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('embed plugins reach only official child frames and update without reloading', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lowcord-embeds-'));
    const app = await launch(dir);
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState('load');
        const youtubeFixture = (await readFile('tests/fixtures/youtube-volume.html', 'utf8')).replace('</body>',
            '<div class="ad-showing"><button class="ytp-ad-skip-button" onclick="window.skipped=true">Skip</button></div></body>');
        await page.route('https://www.youtube.com/embed/**', route => route.fulfill({ contentType: 'text/html',
            body: youtubeFixture }));
        await page.route('https://open.spotify.com/embed/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body><audio></audio></body></html>' }));
        await page.route('https://embed.music.apple.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body><audio></audio></body></html>' }));
        const urls = ['https://www.youtube.com/embed/test', 'https://open.spotify.com/embed/track/test', 'https://embed.music.apple.com/us/album/test/123'];
        await page.evaluate(urls => {
            for (const src of urls) {
                const iframe = document.createElement('iframe'); iframe.src = src;
                if (src.includes('youtube.com')) { iframe.width = '480'; iframe.height = '270'; }
                document.body.append(iframe);
            }
        }, urls);
        await expect.poll(() => page.frames().filter(frame => urls.includes(frame.url())).length).toBe(3);
        const youtube = page.frame({ url: urls[0] });
        const spotify = page.frame({ url: urls[1] });
        const apple = page.frame({ url: urls[2] });
        await expect.poll(() => youtube.evaluate(() => window.skipped)).toBe(true);
        await expect.poll(() => youtube.evaluate(() => document.querySelector('video').volume)).toBe(0.5);
        await expect(youtube.locator('#lowcord-youtube-controls')).toHaveCount(1);
        await youtube.getByRole('button', { name: 'Mute', exact: true }).hover();
        expect(await youtube.evaluate(() => document.elementFromPoint(336, 160).className)).toBe('ytdVolumeControlsNativeSlider');
        const sliderBounds = await youtube.getByRole('slider', { name: 'Volume' }).boundingBox();
        await page.mouse.move(sliderBounds.x + sliderBounds.width / 2, sliderBounds.y + sliderBounds.height * 0.65, { steps: 16 });
        await expect(youtube.getByRole('slider', { name: 'Volume' })).toBeVisible();
        await page.mouse.down();
        await page.mouse.move(sliderBounds.x + sliderBounds.width / 2, sliderBounds.y + sliderBounds.height * 0.8, { steps: 8 });
        await page.mouse.up();
        expect(await youtube.evaluate(() => document.querySelector('video').volume)).toBeLessThan(0.3);
        expect(await youtube.evaluate(() => JSON.parse('{"adSlots":[1],"id":"video"}'))).toEqual({ adSlots: [], id: 'video' });
        for (const frame of [spotify, apple]) {
            await expect.poll(() => frame.evaluate(() => document.querySelector('audio').volume)).toBe(0.5);
            expect(await frame.evaluate(() => typeof window.__LOWCORD_NATIVE__)).toBe('undefined');
        }
        await page.evaluate(() => Lowcord.extensions.setOption('musicVolume', 23));
        await expect.poll(() => youtube.evaluate(() => document.querySelector('video').volume)).toBe(0.23);
        for (const frame of [spotify, apple]) await expect.poll(() => frame.evaluate(() => document.querySelector('audio').volume)).toBe(0.23);
        await page.evaluate(() => { Lowcord.extensions.set('musicEmbeds', false); Lowcord.extensions.set('youtubeAdblock', false); });
        await expect(youtube.locator('#lowcord-youtube-controls')).toHaveCount(1);
        for (const frame of [spotify, apple]) await expect.poll(() => frame.evaluate(() => document.querySelector('audio').volume)).toBe(1);
        expect(await youtube.evaluate(() => document.querySelector('video').volume)).toBe(0.23);
        await expect.poll(() => youtube.evaluate(() => JSON.parse('{"adSlots":[1]}').adSlots)).toEqual([1]);
        await page.evaluate(() => Lowcord.extensions.set('youtubeAdblock', true));
        await expect.poll(() => youtube.evaluate(() => JSON.parse('{"adSlots":[1]}').adSlots)).toEqual([]);
        const untrusted = page.frame({ url: 'http://127.0.0.1:4319/electron-child' });
        expect(await untrusted.evaluate(() => typeof window.__lowcordMusicVolume)).toBe('undefined');
        await expect(page.evaluate(() => window.__LOWCORD_NATIVE__.setEmbedPreferences({ youtubeAdblock: true, musicEmbeds: true, musicVolume: -1 })))
            .rejects.toThrow('Invalid embed preferences');
        expect(await page.evaluate(() => window.__LOWCORD_NATIVE__.resolveSocialLink('https://evil.example/x', 'auto'))).toBe('https://evil.example/x');
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('downloaded update shows a quiet corner notice, dismisses across reloads and restarts only on a real click', async ({}, testInfo) => {
    const dir = await mkdtemp(join(tmpdir(), 'orbitcord-update-'));
    const app = await launch(dir, { updater: true });
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState('load');
        const notice = page.locator('#orbitcord-update-notice');
        await expect(notice).toHaveCount(0);
        await app.evaluate(({ dialog }, updaterPath) => {
            global.testUpdater = process.mainModule.require(updaterPath).autoUpdater;
            global.updateRestarts = 0;
            global.updateDialogs = 0;
            dialog.showMessageBox = async () => { global.updateDialogs++; return { response:1 }; };
            global.testUpdater.quitAndInstall = () => { global.updateRestarts++; };
            global.testUpdater.emit('update-downloaded', { version:'0.1.3' });
        }, resolve('node_modules/electron-updater'));
        await expect(notice.getByRole('heading', { name:'Update ready' })).toBeVisible();
        await expect(notice).toContainText('OrbitCord 0.1.3 is ready to install.');
        expect(await notice.getByRole('heading').evaluate(heading => getComputedStyle(heading).fontFamily)).toContain('Segoe UI');
        expect(await app.evaluate(() => global.updateDialogs)).toBe(0);
        // A page reload restores the pending notice from the main process.
        await page.reload();
        await expect(notice).toBeVisible();
        await page.evaluate(() => {
            document.body.style.background = '#313338';
            document.documentElement.style.setProperty('--background-floating', '#18191c');
            document.documentElement.style.setProperty('--text-normal', '#f2f3f5');
            document.documentElement.style.setProperty('--header-primary', '#f2f3f5');
            document.documentElement.style.setProperty('--text-muted', '#b5bac1');
        });
        const bounds = await notice.boundingBox();
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()?.width ?? 1280);
        expect(bounds.y).toBe(72);
        await page.screenshot({ path:testInfo.outputPath('update-notice-dark.png') });
        // Discord page scripts cannot trigger a restart by synthesizing a click.
        await notice.getByRole('button', { name:'Restart', exact:true }).evaluate(button => button.click());
        expect(await app.evaluate(() => global.updateRestarts)).toBe(0);
        await notice.getByRole('button', { name:'Later', exact:true }).click();
        await expect(notice).toHaveCount(0);
        await app.evaluate(() => global.testUpdater.emit('update-downloaded', { version:'0.1.3' }));
        await page.reload();
        await expect(notice).toHaveCount(0);
        await app.evaluate(() => global.testUpdater.emit('update-downloaded', { version:'0.1.4' }));
        await expect(notice).toContainText('0.1.4');
        await notice.getByRole('button', { name:'Dismiss update notice' }).click();
        await expect(notice).toHaveCount(0);
        await app.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()[0].setBounds({ width:520, height:400 });
            global.testUpdater.emit('update-downloaded', { version:'0.1.5' });
            global.testUpdater.quitAndInstall = () => global.testUpdater.emit('error', new Error('Installer unavailable'));
        });
        await expect(notice).toBeVisible();
        await page.evaluate(() => {
            document.body.style.background = '#fff';
            document.documentElement.style.setProperty('--background-floating', '#fff');
            document.documentElement.style.setProperty('--text-normal', '#313338');
            document.documentElement.style.setProperty('--header-primary', '#111214');
            document.documentElement.style.setProperty('--text-muted', '#4e5058');
        });
        expect((await notice.boundingBox()).width).toBeLessThanOrEqual(488);
        await page.screenshot({ path:testInfo.outputPath('update-notice-light-small.png') });
        await notice.getByRole('button', { name:'Restart', exact:true }).click();
        await expect(notice.getByRole('alert')).toContainText('Couldn’t restart');
        await expect(notice.getByRole('button', { name:'Restart', exact:true })).toBeEnabled();
        await app.evaluate(() => { global.testUpdater.quitAndInstall = () => { global.updateRestarts++; }; });
        await notice.getByRole('button', { name:'Restart', exact:true }).click();
        await expect(notice.getByRole('button', { name:'Restarting…' })).toBeDisabled();
        await expect(notice.getByRole('alert')).toBeHidden();
        expect(await app.evaluate(() => global.updateRestarts)).toBe(1);
        // A duplicate downloaded event must not reset the restarting state.
        await app.evaluate(() => global.testUpdater.emit('update-downloaded', { version:'0.1.5' }));
        await expect(notice.getByRole('button', { name:'Later', exact:true })).toBeDisabled();
        expect(await page.evaluate(() => Object.keys(window.__LOWCORD_NATIVE__)))
            .toEqual(['notify', 'setBadge', 'log', 'openExternal', 'updateStatus', 'checkForUpdates', 'downloadUpdate', 'installUpdate', 'onUpdateStatus', 'appIcon', 'setEmbedPreferences', 'background', 'resolveSocialLink', 'socialPost', 'socialVideo', 'socialMedia', 'redgifsSearch', 'redgifsPrepare', 'redgifsCancel', 'redgifsResolve', 'redgifsRelease', 'reddit', 'videoCompression', 'mediaSources', 'onMediaSource', 'captureRegion', 'copyImage', 'saveImage', 'downloadMedia', 'reportAccount', 'accounts', 'onAccountsChanged']);
        expect(await app.evaluate(() => global.updateDialogs)).toBe(0);
    } finally { await app.close(); await rm(dir, { recursive:true, force:true }); }
});

test('settings checks updates through native IPC and shows network errors and retry results', async ({}, testInfo) => {
    const dir = await mkdtemp(join(tmpdir(), 'orbitcord-update-settings-'));
    const currentVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
    const app = await launch(dir);
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState('load');
        await app.evaluate(({ net }, version) => {
            global.updateChecks = 0;
            net.fetch = async () => {
                global.updateChecks++;
                await new Promise(resolve => setTimeout(resolve, 200));
                return global.updateChecks === 1 ? new Response('', { status: 503 }) : Response.json({
                    tag_name: `v${version}`, html_url: `https://github.com/orbitcord/OrbitCord/releases/tag/v${version}`, assets: [],
                });
            };
        }, currentVersion);
        await page.goto('http://127.0.0.1:4319/extensions');
        await page.waitForFunction(() => window.fixtureReady);
        await page.locator('.lowcord-sidebar-section').getByText('Check for updates', { exact: true }).click();
        const panel = page.getByRole('dialog', { name: 'OrbitCord Settings' });
        await expect(panel.getByRole('heading', { name: 'Check for updates' })).toBeVisible();
        await expect(panel).toContainText(`Current version: ${currentVersion}`);
        await panel.locator('section').getByRole('button', { name: 'Check for updates', exact: true }).click();
        await expect(panel.getByRole('button', { name: 'Checking…' })).toBeDisabled();
        await expect(panel.getByRole('alert')).toContainText('HTTP 503');
        await panel.locator('section').getByRole('button', { name: 'Check for updates', exact: true }).click();
        await expect(panel.getByRole('status')).toHaveText('You’re up to date.');
        await expect(panel.getByRole('alert')).toHaveCount(0);
        expect(await app.evaluate(() => global.updateChecks)).toBe(2);
        await page.screenshot({ path: testInfo.outputPath('update-settings.png') });
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('opened image menu copies full image pixels and saves the original file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orbitcord-image-menu-'));
    const app = await launch(dir);
    let clipboardSaved = false;
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState('domcontentloaded');
        await app.evaluate(async ({ Menu, clipboard, ClipboardItem, nativeImage }) => {
            // Capture the actual native menu produced by a Chromium right-click.
            Menu.prototype.popup = function () { global.imageMenu = this; };
            // Eagerly snapshot every format, including custom OS payloads, so
            // the test can restore the user's clipboard atomically afterwards.
            global.savedClipboard = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item =>
                new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type =>
                    [type, await item.getType(type)]))))));
            global.readCopiedImage = async () => {
                const item = (await clipboard.read()).find(item => item.types.includes('image/png'));
                return item ? nativeImage.createFromBuffer(Buffer.from(await (await item.getType('image/png')).arrayBuffer()))
                    : nativeImage.createEmpty();
            };
        });
        clipboardSaved = true;
        await page.locator('#inline-image').click({ button: 'right' });
        expect(await app.evaluate(() => !!global.imageMenu)).toBe(false);
        await page.getByRole('button', { name: 'Open image' }).click();
        await page.locator('#viewer-image').evaluate(img => img.decode());
        await page.locator('#viewer-image').click({ button: 'right' });
        await expect.poll(() => app.evaluate(() => global.imageMenu?.items.map(item => item.label)))
            .toEqual(['Copy image', 'Save image…']);
        await app.evaluate(({ clipboard }) => { clipboard.clear(); global.imageMenu.items[0].click(); });
        await expect.poll(() => app.evaluate(async () => (await global.readCopiedImage()).getSize()))
            .toEqual({ width: 32, height: 24 });
        // Check image content as well as dimensions, rather than a screenshot
        // of the 160x120 zoomed display.
        const original = await readFile('tests/fixtures/media/sample.png');
        expect(await app.evaluate(async ({ nativeImage }, data) => {
            const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
            return image.toBitmap().equals((await global.readCopiedImage()).toBitmap());
        }, original.toString('base64'))).toBe(true);
        const savePath = join(dir, 'saved-image.png');
        await app.evaluate(({ session }, path) => {
            session.defaultSession.once('will-download', (_event, item) => {
                // Select a test-only save path instead of opening the OS dialog.
                item.setSavePath(path);
                item.once('done', (_event, state) => { global.imageDownloadState = state; });
            });
            global.imageMenu.items[1].click();
        }, savePath);
        await expect.poll(() => app.evaluate(() => global.imageDownloadState)).toBe('completed');
        expect(await readFile(savePath)).toEqual(original);
        await app.evaluate(({ session }) => {
            global.imageDownloadState = undefined;
            session.defaultSession.once('will-download', (_event, item) => {
                item.once('done', (_event, state) => { global.imageDownloadState = state; });
                item.cancel();
            });
            global.imageMenu.items[1].click();
        });
        await expect.poll(() => app.evaluate(() => global.imageDownloadState)).toBe('cancelled');
        await page.getByRole('button', { name: 'Close image' }).click();
        await app.evaluate(() => { global.imageMenu = undefined; });
        await page.locator('#inline-image').click({ button: 'right' });
        expect(await app.evaluate(() => !!global.imageMenu)).toBe(false);
    } finally {
        if (clipboardSaved) await app.evaluate(({ clipboard }) => clipboard.write(global.savedClipboard));
        await app.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('text fields get a native edit menu that pastes, and passkey autofill stays off', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orbitcord-edit-menu-'));
    const app = await launch(dir);
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState('domcontentloaded');
        expect(await page.evaluate(() => PublicKeyCredential.isConditionalMediationAvailable()))
            .toBe(process.platform === 'win32');
        await app.evaluate(({ Menu, clipboard }) => {
            Menu.prototype.popup = function () { global.editMenu = this; };
            global.savedText = clipboard.readText();
            clipboard.writeText('https://example.com/pasted');
        });
        const input = page.locator('#message-input');
        await input.click({ button: 'right' });
        await expect.poll(() => app.evaluate(() => global.editMenu?.items.filter(item => item.label).map(item => item.label)))
            .toEqual(['Cut', 'Copy', 'Paste', 'Paste and Match Style', 'Select All']);
        await app.evaluate(() => global.editMenu.items.find(item => item.label === 'Paste').click());
        await expect(input).toHaveValue('https://example.com/pasted');
        await app.evaluate(() => { global.editMenu = undefined; });
        await page.locator('p').first().click({ button: 'right' });
        expect(await app.evaluate(() => !!global.editMenu)).toBe(false);
    } finally {
        await app.evaluate(({ clipboard }) => clipboard.writeText(global.savedText ?? '')).catch(() => {});
        await app.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('chat screenshots capture real window pixels across scrolling, at page zoom, to the clipboard', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orbitcord-chat-capture-'));
    const app = await launch(dir);
    let clipboardSaved = false;
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState('domcontentloaded');
        await app.evaluate(async ({ BrowserWindow, clipboard, ClipboardItem }) => {
            const window = BrowserWindow.getAllWindows()[0];
            window.setContentSize(720, 480);
            window.show();
            window.webContents.setZoomFactor(1.25);
            global.savedClipboard = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item =>
                new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type =>
                    [type, await item.getType(type)]))))));
            clipboard.clear();
        });
        clipboardSaved = true;
        await page.evaluate(() => {
            const color = i => `rgb(${(i * 50) % 256}, ${(i * 90 + 60) % 256}, ${(i * 130 + 30) % 256})`;
            document.body.insertAdjacentHTML('beforeend', `<div id="capture-chat" style="position:fixed;inset:0;z-index:5;display:flex;flex-direction:column;background:#313338">
                <div style="flex:1;position:relative"><div id="capture-scroller" style="position:absolute;inset:0;overflow-y:auto;background:rgb(49, 51, 56)"><ol data-list-id="chat-messages" style="margin:0;padding:0 0 24px;list-style:none">
                ${Array.from({ length: 30 }, (_, i) => `<li id="chat-messages-7-${i}" style="height:${50 + (i % 3) * 20}px;background:${color(i)}"></li>`).join('')}
                </ol></div><div class="chatGradient_test" style="position:absolute;left:0;right:0;bottom:0;height:16px;pointer-events:none;background:linear-gradient(transparent, black)"></div></div>
                <div class="channelTextArea_test" style="position:relative;height:48px;margin-top:-16px;background:black"><div class="buttons_test" id="capture-buttons"></div></div></div>`);
        });
        // A native resize and zoom confuse Playwright's pointer geometry, so the
        // picks are DOM clicks; the pixels below are real window captures.
        await expect(page.locator('#capture-buttons .lowcord-actions-button')).toHaveCount(1);
        await page.evaluate(() => {
            document.querySelector('#capture-buttons .lowcord-actions-button').click();
            [...document.querySelectorAll('.lowcord-actions-item')].find(item => item.textContent === 'Screenshot messages').click();
        });
        for (const id of [3, 24]) await page.evaluate(id => {
            const row = document.getElementById(`chat-messages-7-${id}`);
            row.scrollIntoView({ block: 'center' });
            row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }, id);
        await expect(page.locator('.lowcord-capture-bar')).toContainText('22 messages selected');
        await page.evaluate(() => [...document.querySelectorAll('.lowcord-capture-bar button')].find(b => b.textContent === 'Capture').click());
        await expect(page.locator('.lowcord-toast')).toContainText('Chat image copied', { timeout: 15000 });
        const rows = await page.evaluate(() => {
            const rows = [...document.querySelectorAll('#capture-chat li')].slice(3, 25);
            const top = rows[0].getBoundingClientRect().top;
            return { width: document.querySelector('#capture-scroller').clientWidth,
                list: rows.map(row => { const r = row.getBoundingClientRect(); return { top: r.top - top, height: r.height, color: row.style.background }; }) };
        });
        const result = await app.evaluate(async ({ clipboard, screen, nativeImage }, rows) => {
            const item = (await clipboard.read()).find(item => item.types.includes('image/png'));
            const image = nativeImage.createFromBuffer(Buffer.from(await (await item.getType('image/png')).arrayBuffer()));
            const size = image.getSize();
            const density = size.width / rows.width;
            const pixel = y => {
                const [b, g, r] = image.crop({ x: 20, y: Math.floor(y * density), width: 1, height: 1 }).toBitmap();
                return [r, g, b];
            };
            return { size, density, scale: screen.getPrimaryDisplay().scaleFactor,
                samples: rows.list.flatMap(row => Array.from({ length: Math.floor((row.height - 4) / 4) }, (_, i) => row.top + 2 + i * 4).map(y => ({ want: row.color, got: pixel(y) }))) };
        }, rows);
        expect(result.density).toBeCloseTo(1.25 * result.scale, 1);
        const total = rows.list.at(-1).top + rows.list.at(-1).height;
        expect(Math.abs(result.size.height - total * result.density)).toBeLessThanOrEqual(2);
        // Allow for the display colour profile; neighbouring rows differ by far more.
        const off = result.samples.filter(({ want, got }) => want.match(/\d+/g).map(Number).some((value, i) => Math.abs(value - got[i]) > 14));
        expect(off).toEqual([]);
    } finally {
        if (clipboardSaved) await app.evaluate(({ clipboard }) => clipboard.write(global.savedClipboard));
        await app.close();
        await rm(dir, { recursive: true, force: true });
    }
});
