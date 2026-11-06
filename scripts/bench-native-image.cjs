// Reproducible whole-job benchmark, including worker/process startup and binary
// transfer. Synthetic PNGs contain valid random RGBA pixels and removable text;
// JPEGs contain a long entropy scan to isolate the parser without re-encoding.
const { Worker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { resolve, join } = require('node:path');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir, cpus, totalmem } = require('node:os');
const { randomFillSync, createHash } = require('node:crypto');
const { deflateSync } = require('node:zlib');
const { spawn } = require('node:child_process');
const { sanitizeNativeImage } = require('../electron/native-image.cjs');
const { sanitizeImage, pngChunk } = require('../electron/privacy-files.cjs');
const executable = resolve('src-tauri/target/release', `lowcord-native${process.platform === 'win32' ? '.exe' : ''}`);
function worker(bytes) {
    return new Promise((resolve, reject) => {
        const w = new Worker(require.resolve('../electron/privacy-worker.cjs'));
        w.once('error', reject); w.once('message', async result => { await w.terminate(); resolve(result); });
        w.postMessage(bytes);
    });
}
const native = bytes => sanitizeNativeImage(executable, bytes);
function png(mib) {
    const width = 1024, height = Math.floor(mib * 1024 * 1024 / (width * 4 + 1));
    const pixels = randomFillSync(Buffer.alloc(height * (width * 4 + 1)));
    for (let y = 0; y < height; y++) pixels[y * (width * 4 + 1)] = 0;
    const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
    return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'), pngChunk('IHDR',header), pngChunk('tEXt',Buffer.from('Author\0Private')), pngChunk('IDAT',deflateSync(pixels,{level:1})),pngChunk('IEND',Buffer.alloc(0))]);
}
function jpeg(mib) {
    return Buffer.concat([Buffer.from([255,216,255,254,0,9]),Buffer.from('Private'),Buffer.from([255,218,0,2]),Buffer.alloc(mib * 1024 * 1024,42),Buffer.from([255,217])]);
}
const median = values => values.slice().sort((a,b)=>a-b)[Math.floor(values.length/2)];
async function peak(implementation, path) {
    if (process.platform !== 'darwin') return null;
    const args = implementation === 'rust' ? [executable,'--sanitize-image'] : [process.execPath,__filename,'--memory-worker',path];
    const { openSync, closeSync } = require('node:fs');
    const fd = implementation === 'rust' ? openSync(path,'r') : null;
    try {
        return await new Promise((resolve,reject) => {
            const child = spawn('/usr/bin/time',['-l',...args],{stdio:[fd ?? 'ignore','ignore','pipe']});
            let stderr = ''; child.stderr.on('data',b=>stderr+=b); child.once('error',reject);
            child.once('close',code=>code ? reject(new Error(stderr)) : resolve(Number(/(\d+)\s+maximum resident set size/.exec(stderr)?.[1]) / 1024 ** 2));
        });
    } finally { if (fd !== null) closeSync(fd); }
}
async function main() {
    if (process.argv[2] === '--memory-worker') { await worker(require('node:fs').readFileSync(process.argv[3])); return; }
    const directory = await mkdtemp(join(tmpdir(),'lowcord-rust-bench-'));
    const report = { at: new Date().toISOString(), platform: process.platform, arch: process.arch, cpu: cpus()[0].model,
        ramGiB: totalmem()/1024**3, node:process.version, iterations:15, notes: 'Whole-job latency includes startup, input/output transfer and JS worker termination. Peak RSS: macOS time -l, separate cold runs; JS includes host and worker (same process), Rust is child only. Shared Electron/renderer memory excluded. PNG pixels are valid random RGBA; JPEG scan is synthetic parser workload, not a decoding benchmark.', results:[] };
    try {
        for (const [format,create] of [['png',png],['jpeg',jpeg]]) for (const mib of [1,8,32]) {
            const bytes = create(mib), expected = sanitizeImage(bytes);
            const hash = b => createHash('sha256').update(b).digest('hex');
            const times = { javascript:[], rust:[] };
            for (let i = -2; i < report.iterations; i++) {
                for (const implementation of i % 2 ? ['javascript','rust'] : ['rust','javascript']) {
                    const start = performance.now(); const result = await (implementation === 'rust' ? native(bytes) : worker(bytes));
                    const elapsed = performance.now()-start;
                    if (result.status !== 'processed' || hash(result.bytes) !== hash(expected.bytes)) throw new Error('Output mismatch');
                    if (i >= 0) times[implementation].push(elapsed);
                }
            }
            const path = join(directory,`${format}-${mib}`); await writeFile(path,bytes);
            const rss = {};
            for (const impl of ['javascript','rust']) { const samples=[]; for(let i=0;i<3;i++) samples.push(await peak(impl,path)); rss[impl]=median(samples); }
            const row = { format, inputMiB:bytes.length/1024**2, jsMedianMs:median(times.javascript), rustMedianMs:median(times.rust),
                speedup:median(times.javascript)/median(times.rust), jsPeakMiB:rss.javascript, rustChildPeakMiB:rss.rust, samplesMs:times };
            report.results.push(row); console.log(JSON.stringify(row));
        }
        const output = resolve('output/rust-image-benchmark.json'); await writeFile(output,JSON.stringify(report,null,2)+'\n'); console.log(output);
    } finally { await rm(directory,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
