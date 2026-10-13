const { execFile } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

// app.dock.setIcon only lasts while the app runs. Finder and the Dock show a
// quit app's bundle icon, so store the selection as the bundle's custom icon
// (the same as pasting one in Get Info). An update replaces the bundle and
// drops it; startup puts it back.
const script = `
ObjC.import('AppKit');
function run([bundle, icon]) {
    const workspace = $.NSWorkspace.sharedWorkspace;
    const image = icon ? $.NSImage.alloc.initWithContentsOfFile(icon) : $();
    if (!workspace.setIconForFileOptions(image, bundle, 0)) throw new Error('Could not set the app icon');
    workspace.noteFileSystemChanged(bundle);
}`;

const bundlePath = executable => resolve(executable, '..', '..', '..');
const hasCustomIcon = bundle => existsSync(join(bundle, 'Icon\r'));

// osascript cannot read files inside app.asar; give it a real copy.
function iconFile(source, userData) {
    const directory = join(userData, 'app-icons');
    mkdirSync(directory, { recursive: true });
    const target = join(directory, 'mac-bundle.png');
    writeFileSync(target, readFileSync(source));
    return target;
}

function setBundleIcon(bundle, icon) {
    return new Promise((done, fail) => execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, bundle, icon || ''],
        { timeout: 15_000 }, error => error ? fail(error) : done()));
}

// `icon` is the selected PNG, or null to restore the bundle's own icon.
// `changed` is false on startup, where a matching bundle is left alone.
// Updates run in order so fast clicks end on the last selection.
let pending = Promise.resolve();
function applyMacBundleIcon(icon, { executable, userData, changed }) {
    const bundle = bundlePath(executable);
    if (!bundle.endsWith('.app')) return Promise.resolve();
    pending = pending.catch(() => {}).then(() => {
        if (!changed && hasCustomIcon(bundle) === Boolean(icon)) return;
        return setBundleIcon(bundle, icon && iconFile(icon, userData));
    });
    return pending;
}

module.exports = { applyMacBundleIcon };
