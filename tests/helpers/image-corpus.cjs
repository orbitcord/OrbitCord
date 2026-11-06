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
async function inspectionCorpus() {
    const cases=[], pending=[];
    const source=readFileSync(require.resolve('../privacy-files.test.cjs'),'utf8');
    runInNewContext(source,{Buffer,Uint8Array,TextDecoder,require:name=>{
        if(name==='node:assert/strict'){const assert=require(name);return {...assert,deepEqual:(a,b)=>assert.deepEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)))};}
        if(name==='node:test')return {test:(_name,fn)=>{pending.push(Promise.resolve(fn()));}};
        if(name==='../electron/privacy-files.cjs')return {...privacy,inspectAttachment:options=>{
            const result=privacy.inspectAttachment(options);cases.push({options,result});return result;
        }};
        return require(name);
    }});
    await Promise.all(pending);
    return Promise.all(cases.map(async({options,result})=>({name:options.name,bytes:await options.read(0,options.size),expected:await result})));
}
module.exports = { imageCorpus,inspectionCorpus };
