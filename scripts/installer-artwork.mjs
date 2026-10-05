// Deterministic installer artwork. Run with `pnpm installer:artwork` after
// changing this design or the app icon. Checked-in outputs need no render tools
// on release builders. Raster text is limited to the Finder background footer;
// Windows headings remain real controls for font scaling and accessibility.
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './build.mjs';

const out = join(root, 'build', 'installers');
await mkdir(out, { recursive: true });
const icon = `data:image/png;base64,${(await readFile(join(root, 'src-tauri/icons/app/default.png'))).toString('base64')}`;
const browser = await chromium.launch();
const windowsOnly = process.argv.includes('--win');

// NSIS consumes bottom-up, padded, 24-bit BMPs. Encode the browser's rendered
// pixels directly, keeping the artwork generator free of imaging dependencies.
async function bmp(page, file, width, height) {
    const pixels = await page.evaluate(async () => {
        const svg = document.querySelector('svg');
        const img = new Image();
        img.src = `data:image/svg+xml;base64,${btoa(new XMLSerializer().serializeToString(svg))}`;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return [...ctx.getImageData(0, 0, canvas.width, canvas.height).data];
    });
    const stride = (width * 3 + 3) & ~3;
    const data = Buffer.alloc(54 + stride * height);
    data.write('BM'); data.writeUInt32LE(data.length, 2); data.writeUInt32LE(54, 10);
    data.writeUInt32LE(40, 14); data.writeInt32LE(width, 18); data.writeInt32LE(height, 22);
    data.writeUInt16LE(1, 26); data.writeUInt16LE(24, 28); data.writeUInt32LE(stride * height, 34);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const src = (y * width + x) * 4, dest = 54 + (height - 1 - y) * stride + x * 3;
        data[dest] = pixels[src + 2]; data[dest + 1] = pixels[src + 1]; data[dest + 2] = pixels[src];
    }
    await writeFile(join(out, file), data);
}

async function render(width, height, contents, scale = 1) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
    await page.setContent(`<style>html,body{margin:0;overflow:hidden}svg{display:block}</style>
        <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${contents}</svg>`);
    await page.locator('svg image').evaluateAll(images => Promise.all(images.map(async image => {
        const img = new Image(); img.src = image.getAttribute('href'); await img.decode();
    })));
    return page;
}

try {
    // A pale-blue glass impression and a cropped orbital ring. This is opaque
    // artwork, keeping Finder and NSIS rendering predictable on every theme.
    const frost = (width, height) => `<defs>
        <linearGradient id="frost" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f1f7ff"/><stop offset=".55" stop-color="#e6f0ff"/><stop offset="1" stop-color="#d4e5ff"/></linearGradient>
        <radialGradient id="light"><stop stop-color="#fff" stop-opacity=".7"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
        </defs><rect width="${width}" height="${height}" fill="url(#frost)"/>
        <ellipse cx="${width * .34}" cy="${height * .23}" rx="${width * .65}" ry="${height * .8}" fill="url(#light)"/>
        <circle cx="${width * 1.18}" cy="${height * .91}" r="${width * .41}" fill="none" stroke="#fff" stroke-opacity=".38" stroke-width="${width * .065}"/>
        <circle cx="${width * 1.18}" cy="${height * .91}" r="${width * .445}" fill="none" stroke="#fff" stroke-opacity=".65" stroke-width="1"/>`;
    const mac = `${frost(640, 360)}
        <path d="M295 146h50m-14-14 14 14-14 14" stroke="#93a9c9" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        <text x="320" y="309" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Arial,sans-serif" font-size="13" fill="#516c94">Then open OrbitCord from Applications.</text>`;
    for (const scale of windowsOnly ? [] : [1, 2]) {
        const page = await render(640, 360, mac, scale);
        await page.screenshot({ path: join(out, `mac-background${scale === 2 ? '@2x' : ''}.png`) });
        await page.close();
    }
    const designs = [
        // 2x artwork is downsampled with HALFTONE by the Windows UI. Text and
        // keyboard-accessible buttons are native controls layered above it.
        ['windows-background.bmp', 1440, 840, `${frost(1440, 840)}<image href="${icon}" x="608" y="56" width="224" height="224"/>`],
        ['windows-finish.bmp', 1440, 840, `${frost(1440, 840)}
            <circle cx="720" cy="188" r="112" fill="#fff" fill-opacity=".48"/>
            <image href="${icon}" x="640" y="108" width="160" height="160"/>
            <circle cx="786" cy="254" r="31" fill="#fff"/>
            <circle cx="786" cy="254" r="26" fill="#247bf3"/>
            <path d="m774 254 8 8 16-18" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`],
        ['windows-header.bmp', 150, 57, `<rect width="150" height="57" fill="#eaf2ff"/><image href="${icon}" x="100" y="11" width="36" height="36"/>`],
        ['windows-sidebar.bmp', 164, 314, `${frost(164, 314)}<image href="${icon}" x="38" y="106" width="88" height="88"/>`],
    ];
    for (const [file, width, height, content] of designs) {
        const page = await render(width, height, content);
        await bmp(page, file, width, height);
        if (file === 'windows-background.bmp' || file === 'windows-finish.bmp') {
            await page.screenshot({ path: join(out, file.replace('.bmp', '.png')) });
        }
        await page.close();
    }
} finally { await browser.close(); }
