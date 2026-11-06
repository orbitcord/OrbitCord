const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const privacy = require('../../electron/privacy-files.cjs');

// Capture every sanitizer input from the existing behavioral tests, preserving
// their independently specified expected outputs as well as parity coverage.
function imageCorpus() {
    const cases = [];
    const source = readFileSync(require.resolve('../privacy-files.test.cjs'), 'utf8');
    runInNewContext(source, { Buffer, Uint8Array, require: name => {
        if (name === 'node:test') return { test: (name, fn) => { if (!/AsyncFunction/.test(fn.constructor.name)) fn(); } };
        if (name === '../electron/privacy-files.cjs') return { ...privacy, sanitizeImage: bytes => {
            cases.push({ name: `behavior-${cases.length}`, bytes }); return privacy.sanitizeImage(bytes);
        } };
        return require(name);
    } });
    return cases;
}
module.exports = { imageCorpus };
