const { spawn } = require('node:child_process');
const MAX_IMAGE = 64 * 1024 * 1024;

// One short-lived Rust job per image, bounded by the caller's two-job limit.
// No JSON expansion of media bytes and no work on the native command loop.
function sanitizeNativeImage(executable, bytes, { signal, timeout = 30_000 } = {}) {
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_IMAGE)
        return Promise.reject(new Error('Invalid image or image larger than 64 MiB'));
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const child = spawn(executable, ['--sanitize-image'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        const chunks = [];
        let length = 0, settled = false;
        const done = (error, result) => {
            if (settled) return;
            settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
            if (error) { child.kill(); reject(error); } else resolve(result);
        };
        const abort = () => done(signal.reason ?? new Error('Image preparation cancelled'));
        const timer = setTimeout(() => done(new Error('Image preparation timed out')), timeout);
        signal?.addEventListener('abort', abort, { once: true });
        child.once('error', error => done(error));
        child.stdin.on('error', error => done(error));
        child.stdout.on('data', chunk => {
            length += chunk.length;
            if (length > MAX_IMAGE + 65540) return done(new Error('Invalid native image response'));
            chunks.push(chunk);
        });
        child.once('close', code => {
            if (settled) return;
            if (code !== 0) return done(new Error('Image preparation ended before returning a result'));
            try {
                const output = Buffer.concat(chunks, length);
                if (output.length < 4) throw new Error('Invalid native image response');
                const header = output.readUInt32LE(0);
                if (header > 65536 || 4 + header > output.length) throw new Error('Invalid native image response');
                const result = JSON.parse(output.toString('utf8', 4, 4 + header));
                if (!['processed', 'unsupported', 'uninspectable'].includes(result.status)) throw new Error('Invalid native image response');
                if (result.status === 'processed') result.bytes = output.subarray(4 + header);
                done(null, result);
            } catch (error) { done(error); }
        });
        child.stdin.end(bytes);
    });
}
module.exports = { sanitizeNativeImage };
