import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const { migrateProfile } = createRequire(import.meta.url)('../electron/profile.cjs');

test('profile migration preserves data, is idempotent, and never overwrites newer storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lowcord-migration-'));
    const source = join(root, 'cef'), target = join(root, 'electron');
    try {
        await mkdir(join(source, 'Default', 'Local Storage'), { recursive: true });
        await writeFile(join(source, 'Default', 'Local Storage', 'sample'), 'old-preferences');
        await migrateProfile(target, source);
        assert.equal(await readFile(join(target, 'Local Storage', 'sample'), 'utf8'), 'old-preferences');
        await writeFile(join(target, 'Local Storage', 'sample'), 'new-preferences');
        await migrateProfile(target, source);
        assert.equal(await readFile(join(target, 'Local Storage', 'sample'), 'utf8'), 'new-preferences');
        await rm(join(target, 'lowcord-migrated'));
        await migrateProfile(target, source);
        assert.equal(await readFile(join(target, 'Local Storage', 'sample'), 'utf8'), 'new-preferences');
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('does not copy a profile while its Chromium process is running', { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'lowcord-live-profile-'));
    try {
        const source = join(root, 'cef');
        await mkdir(join(source, 'Default', 'Local Storage'), { recursive: true });
        await symlink(`host-${process.pid}`, join(source, 'SingletonLock'));
        await assert.rejects(migrateProfile(join(root, 'electron'), source), /Quit the old/);
    } finally { await rm(root, { recursive: true, force: true }); }
});
