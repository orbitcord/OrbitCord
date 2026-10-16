const { spawn } = require('node:child_process');
const { stat } = require('node:fs/promises');
const { join } = require('node:path');

const failure = code => Object.assign(new Error(code), { code });
let executable, encoding = false;

function run(command, args, signal, timeout = 180_000) {
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        let diagnostic = '', expired = false;
        child.stderr.on('data', part => { diagnostic = (diagnostic + part).slice(-65_536); });
        const abort = () => child.kill('SIGKILL');
        signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => { expired = true; abort(); }, timeout);
        child.on('error', reject);
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
async function compressVideo(input, directory, limit, signal) {
    if (encoding) throw failure('encode-busy');
    encoding = true;
    try {
        const command = await findFFmpeg(signal);
        const probe = await run(command, ['-hide_banner', '-protocol_whitelist', 'file', '-f', 'mp4', '-i', input], signal, 10_000);
        const match = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe.diagnostic);
        const seconds = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN;
        if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) throw failure('unsupported-duration');
        const output = join(directory, 'compressed.mp4');
        // Budget includes audio and MP4 overhead. Validate actual bytes after
        // encoding; an underestimated bitrate retries once at half the rate.
        let bitrate = Math.floor(limit * 0.90 * 8 / seconds - 64_000);
        for (let attempt = 0; attempt < 2; attempt++, bitrate = Math.floor(bitrate / 2)) {
            if (bitrate < 32_000) break;
            const result = await run(command, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
                '-protocol_whitelist', 'file', '-f', 'mp4', '-threads', '2', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1',
                '-vf', "scale=w='min(720,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30,setsar=1",
                '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-threads', '2', '-filter_threads', '1',
                '-b:v', String(bitrate), '-maxrate', String(bitrate), '-bufsize', String(bitrate * 2),
                '-c:a', 'aac', '-b:a', '64000', '-movflags', '+faststart', output], signal);
            if (result.code !== 0) throw failure('encode-failed');
            const { size } = await stat(output);
            if (size > 0 && size < limit) return output;
        }
        throw failure('too-large');
    } finally { encoding = false; }
}

module.exports = { compressVideo };
