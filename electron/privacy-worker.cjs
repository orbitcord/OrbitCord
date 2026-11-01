const { parentPort } = require('node:worker_threads');
const { sanitizeImage } = require('./privacy-files.cjs');
parentPort.once('message', bytes => {
    const result = sanitizeImage(bytes);
    parentPort.postMessage(result, result.bytes ? [result.bytes.buffer] : []);
});
