import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus, totalmem, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const index = arg.indexOf('=');
    if (!arg.startsWith('--') || index < 0) throw new Error('Use --option=value');
    return [arg.slice(2, index), arg.slice(index + 1)];
}));
const { pickerFixture, gifFixture, gifFrames } = createRequire(import.meta.url)('../tests/fixtures/efficiency.cjs');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const gc = () => { for (let i = 0; i < 3; i++) global.gc(); };

if (args.worker) {
    const directory = resolve(args.directory);
    if (args.worker === 'gif') {
        const source = await readFile(join(directory, 'src-tauri/injection/gif.js'), 'utf8');
        const frames = gifFrames(); gc(); const before = process.memoryUsage();
        const window = gifFixture(source);
        gc(); const idle = process.memoryUsage();
        const start = performance.now(), cpu = process.cpuUsage();
        const encoded = window.Lowcord.gif.encodeFrames(frames);
        const elapsedMs = performance.now() - start, usage = process.cpuUsage(cpu);
        const outputHash = digest(Buffer.concat(encoded));
        // Keep the initialized module reachable while collecting work buffers.
        encoded.length = 0; await new Promise(setImmediate); gc(); const after = process.memoryUsage();
        if (typeof window.Lowcord.gif.fromVideo !== 'function') throw new Error('GIF API missing');
        console.log(JSON.stringify({ scenario: 'gif', idleArrayBuffersMiB: (idle.arrayBuffers - before.arrayBuffers) / 1024 ** 2,
            retainedArrayBuffersMiB: (after.arrayBuffers - before.arrayBuffers) / 1024 ** 2,
            elapsedMs, cpuMs: (usage.user + usage.system) / 1000, outputHash }));
    } else {
        const fixture = pickerFixture(directory, args.worker);
        try {
            // Fill the bounded 4,096-token table before timing further pages.
            for (let page = 1; page <= 180; page++) await fixture.page(page);
            gc(); const start = performance.now(), cpu = process.cpuUsage();
            const normalized = [];
            for (let page = 181; page <= 280; page++) {
                const result = await fixture.page(page);
                if (result.items.length !== fixture.count) throw new Error('Missing picker items');
                normalized.push(JSON.stringify(result).replace(/[a-f0-9]{36}/g, '<token>'));
            }
            const elapsedMs = performance.now() - start, usage = process.cpuUsage(cpu);
            console.log(JSON.stringify({ scenario: args.worker, pages: 100, items: 100 * fixture.count,
                elapsedMs, cpuMs: (usage.user + usage.system) / 1000, outputHash: digest(normalized.join('\n')) }));
        } finally { await fixture.service.close(); }
    }
} else {
    if (!args.baseline) throw new Error('Provide --baseline=/absolute/path/to/source-snapshot');
    const iterations = Number(args.iterations ?? 5);
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 30) throw new Error('Invalid iteration count');
    const variants = [{ name: 'baseline', directory: resolve(args.baseline) }, { name: 'current', directory: root }];
    const report = { environment: { node: process.version, platform: process.platform, arch: process.arch,
        cpu: cpus()[0]?.model, ramGiB: totalmem() / 1024 ** 3, recordedAt: new Date().toISOString() },
        iterations, variants, sources: {}, results: [] };
    const output = resolve(args.output ?? join(tmpdir(), 'lowcord-efficiency.json'));
    for (const variant of variants) report.sources[variant.name] = Object.fromEntries(await Promise.all(
        ['electron/redgifs.cjs', 'electron/reddit.cjs', 'src-tauri/injection/gif.js'].map(async file =>
            [file, digest(await readFile(join(variant.directory, file)))])));
    await mkdir(dirname(output), { recursive: true });
    try {
        for (const scenario of ['gif', 'redgifs', 'reddit']) for (let repeat = 0; repeat < iterations; repeat++) {
            for (const variant of repeat % 2 ? variants.slice().reverse() : variants) {
                const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url),
                    `--worker=${scenario}`, `--directory=${variant.directory}`], { encoding: 'utf8', timeout: 120_000 });
                if (child.status !== 0) throw new Error(child.stderr || child.error?.message || 'Benchmark worker failed');
                const result = { ...JSON.parse(child.stdout), variant: variant.name, repeat };
                const pair = report.results.find(value => value.scenario === scenario && value.repeat === repeat);
                if (pair && pair.outputHash !== result.outputHash) throw new Error('Benchmark behavior differs');
                report.results.push(result); console.log(JSON.stringify(result));
            }
        }
        const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
        report.summary = [];
        for (const scenario of ['gif', 'redgifs', 'reddit']) for (const variant of variants) {
            const samples = report.results.filter(row => row.scenario === scenario && row.variant === variant.name);
            report.summary.push({ scenario, variant: variant.name, ...Object.fromEntries(
                (scenario === 'gif' ? ['idleArrayBuffersMiB', 'retainedArrayBuffersMiB', 'elapsedMs', 'cpuMs'] : ['elapsedMs', 'cpuMs'])
                    .map(key => [key, median(samples.map(row => row[key]))])) });
        }
        console.log(JSON.stringify({ summary: report.summary, output }));
    } catch (error) { report.error = error.stack; throw error; }
    finally { await writeFile(output, JSON.stringify(report, null, 2)); }
}
