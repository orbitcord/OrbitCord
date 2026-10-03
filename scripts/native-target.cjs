const { readFile } = require('node:fs/promises');

const targets = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
};

function nativeTarget(platform, arch) {
    const target = targets[`${platform}-${arch}`];
    if (!target) throw new Error(`Unsupported native target: ${platform}-${arch}`);
    return target;
}

async function validateNative(file, platform, arch) {
    const data = await readFile(file);
    let matches = false;
    if (platform === 'win32' && data.length >= 64 && data.toString('ascii', 0, 2) === 'MZ') {
        const pe = data.readUInt32LE(60);
        matches = pe + 6 <= data.length && data.toString('ascii', pe, pe + 4) === 'PE\0\0'
            && data.readUInt16LE(pe + 4) === (arch === 'arm64' ? 0xaa64 : 0x8664);
    } else if (platform === 'darwin' && data.length >= 8 && data.readUInt32LE(0) === 0xfeedfacf) {
        matches = data.readUInt32LE(4) === (arch === 'arm64' ? 0x100000c : 0x1000007);
    } else if (platform === 'linux' && data.length >= 20 && data.toString('ascii', 0, 4) === '\x7fELF') {
        matches = data[4] === 2 && data[5] === 1 && data.readUInt16LE(18) === (arch === 'arm64' ? 183 : 62);
    }
    if (!matches) throw new Error(`Rust backend ${file} does not match ${platform}-${arch}. Rebuild it before packaging.`);
}

module.exports = { nativeTarget, validateNative };
