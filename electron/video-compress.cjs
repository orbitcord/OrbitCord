const { spawn } = require('node:child_process');
const { stat } = require('node:fs/promises');
const { join } = require('node:path');

const failure = code => Object.assign(new Error(code), { code });
let executable, encoding = false;
const waiting = [];

async function acquire(signal) {
    signal?.throwIfAborted();
    if (!encoding) { encoding = true; return; }
    if (waiting.length >= 8) throw failure('encode-busy');
    await new Promise((resolve, reject) => {
        const entry = { resolve: () => { signal?.removeEventListener('abort', abort); resolve(); } };
        const abort = () => { waiting.splice(waiting.indexOf(entry), 1); reject(signal.reason); };
        signal?.addEventListener('abort', abort, { once: true });
        waiting.push(entry);
    });
}

function run(command, args, signal, timeout = 180_000) {
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        let diagnostic = '', expired = false;
        child.stderr.on('data', part => { diagnostic = (diagnostic + part).slice(-65_536); });
        const abort = () => child.kill('SIGKILL');
        signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => { expired = true; abort(); }, timeout);
        child.on('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error); });
        child.on('close', code => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            if (signal?.aborted) reject(signal.reason);
            else if (expired) reject(failure('encode-timeout'));
            else resolve({ code, diagnostic });
        });
    });
}

async function findFFmpeg(signal) {
    if (executable) return executable;
    const candidates = ['ffmpeg', ...(process.platform === 'darwin' ? ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'] : [])];
    for (const candidate of candidates) {
        try {
            const result = await run(candidate, ['-version'], signal, 5000);
            if (result.code === 0) return executable = candidate;
        } catch (error) { if (signal?.aborted) throw error; }
    }
    throw failure('ffmpeg-missing');
}

// Only local files reach FFmpeg. No remote URL, renderer-supplied command or
// credentials are passed to the child process. Nothing is loaded at startup.
async function compressVideo(input, directory, limit, signal, { general = false, audioInput = null, remux = false } = {}) {
    await acquire(signal);
    try {
        signal?.throwIfAborted();
        if (!Number.isSafeInteger(limit) || limit < 1000 || limit > 100_000_000) throw failure('invalid-limit');
        const command = await findFFmpeg(signal);
        // Only self-contained media containers: playlists and network protocols
        // never reach a demuxer. RedGIFs keeps its explicit MP4 input contract.
        const demux = general ? ['-format_whitelist', 'mov,matroska,webm,avi,mpeg,mpegts,asf,flv,ogg,gif,apng,webp_pipe'] : ['-f', 'mp4'];
        const inputs = [...demux, '-i', input, ...(audioInput ? [...demux, '-i', audioInput] : [])];
        const maps = ['-map', '0:v:0', '-map', audioInput ? '1:a:0?' : '0:a:0?', '-sn', '-dn', '-map_metadata', '-1'];
        const probe = await run(command, ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file', ...inputs], signal, 10_000);
        const match = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe.diagnostic);
        const seconds = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN;
        if (!Number.isFinite(seconds) || seconds <= 0 || seconds > (general ? 21_600 : 600)) throw failure('unsupported-duration');
        const output = join(directory, 'compressed.mp4');
        if (general && remux && /Video:\s*h264\b/i.test(probe.diagnostic) && (!/Audio:/i.test(probe.diagnostic) || /Audio:\s*aac\b/i.test(probe.diagnostic))) {
            const inputBytes = (await stat(input)).size + (audioInput ? (await stat(audioInput)).size : 0);
            if (inputBytes > 0 && inputBytes < limit * 0.92) {
                const copy = await run(command, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
                    '-protocol_whitelist', 'file', ...inputs, ...maps,
                    '-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart', output], signal, 60_000);
                if (copy.code === 0) {
                    const { size } = await stat(output).catch(() => ({ size: 0 }));
                    if (size > 0 && size < limit) return output;
                }
            }
        }
        // Budget includes audio and MP4 overhead. Validate actual bytes after
        // encoding; an underestimated bitrate retries once at half the rate.
        let bitrate = Math.floor(limit * 0.90 * 8 / seconds - 64_000);
        for (let attempt = 0; attempt < 2; attempt++, bitrate = Math.floor(bitrate / 2)) {
            if (bitrate < 32_000) break;
            const result = await run(command, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
                '-protocol_whitelist', 'file', '-threads', '2', ...inputs, ...maps,
                '-vf', "scale=w='min(720,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30,setsar=1",
                '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-threads', '2', '-filter_threads', '1',
                '-b:v', String(bitrate), '-maxrate', String(bitrate), '-bufsize', String(bitrate * 2),
                '-c:a', 'aac', '-b:a', '64000', '-movflags', '+faststart', output], signal, general ? 900_000 : 180_000);
            if (result.code !== 0) throw failure('encode-failed');
            const { size } = await stat(output);
            if (size > 0 && size < limit) return output;
        }
        throw failure('too-large');
    } finally { if (waiting.length) waiting.shift().resolve(); else encoding = false; }
}

// Still images use PNG to retain transparency with FFmpeg’s built-in encoder.
// Reduce dimensions only as needed; share the video queue to bound encoding work.
async function compressImage(input, directory, limit, signal) {
    await acquire(signal);
    try {
        signal?.throwIfAborted();
        if (!Number.isSafeInteger(limit) || limit < 1000 || limit > 100_000_000) throw failure('invalid-limit');
        const command = await findFFmpeg(signal);
        const output = join(directory, 'compressed.png');
        let edge = 4096;
        for (let attempt = 0; attempt < 4; attempt++) {
            const result = await run(command, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
                '-protocol_whitelist', 'file', '-format_whitelist', 'image2,png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,tiff_pipe,mov',
                '-threads', '2', '-i', input, '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn', '-map_metadata', '-1',
                '-vf', `scale=w='min(${edge},iw)':h='min(${edge},ih)':force_original_aspect_ratio=decrease`,
                '-c:v', 'png', '-compression_level', '6',
                '-threads', '2', '-filter_threads', '1', output], signal);
            if (result.code !== 0) throw failure('encode-failed');
            const { size } = await stat(output);
            if (size > 0 && size < limit) return output;
            edge = Math.max(1, Math.floor(edge * Math.min(.8, Math.sqrt(limit * .85 / size))));
        }
        throw failure('too-large');
    } finally { if (waiting.length) waiting.shift().resolve(); else encoding = false; }
}

module.exports = { compressVideo, compressImage };
