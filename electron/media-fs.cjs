// Preserve the existing handle contract while Rust owns temporary media I/O.
// The Node implementation is kept for isolated tests and source baselines.
const fs = require('node:fs/promises');
const native = require('./native-media.cjs');
const call = async (command,args,bytes) => (await native.service().call(command,args,bytes)).value;
const metadata = value => ({ size:value.size,isFile:()=>value.file });
async function open(path,flags,mode) {
    if(!native.enabled())return fs.open(path,flags,mode);
    const service=native.service();
    const fileCall=async(command,args,bytes)=>(await service.call(command,args,bytes)).value;
    const handle=await fileCall('open',{path,flags});let closed=false;
    return {
        read:async(buffer,offset=0,length=buffer.length,position=null)=>{
            const r=await service.call('read',{handle,length,position});r.bytes.copy(buffer,offset);return {bytesRead:r.value,buffer};
        },
        write:async(buffer,offset=0,length=buffer.length,position=null)=>({bytesWritten:await fileCall('write',{handle,position},buffer.subarray(offset,offset+length)),buffer}),
        writeFile:async bytes=>{await fileCall('write',{handle},bytes);},
        stat:async()=>metadata(await fileCall('stat',{handle})),
        close:async()=>{if(!closed){closed=true;await fileCall('close',{handle});}},
    };
}
function createReadStream(path, options = {}) {
    if(!native.enabled())return require('node:fs').createReadStream(path,options);
    const {Readable}=require('node:stream');
    return Readable.from((async function*(){
        const file=await open(path,'r');let at=options.start??0;
        try{const end=options.end??(await file.stat()).size-1;
            while(at<=end){const buffer=Buffer.alloc(Math.min(options.highWaterMark??65536,end-at+1));const {bytesRead}=await file.read(buffer,0,buffer.length,at);if(!bytesRead)break;at+=bytesRead;yield buffer.subarray(0,bytesRead);}
        }finally{await file.close();}
    })(),{objectMode:false,highWaterMark:options.highWaterMark??65536});
}
function createWriteStream(path,options={}) {
    if(!native.enabled())return require('node:fs').createWriteStream(path,options);
    const {Writable}=require('node:stream');let file;
    // Batch small network chunks into at most roughly 1 MiB per write.
    // A pipe round trip per 64 KiB chunk otherwise dominates disk throughput.
    return new Writable({highWaterMark:1024*1024,
        construct(callback){open(path,options.flags??'w').then(value=>{file=value;callback();},callback);},
        write(chunk,_encoding,callback){file.writeFile(chunk).then(()=>callback(),callback);},
        writev(chunks,callback){file.writeFile(Buffer.concat(chunks.map(item=>item.chunk))).then(()=>callback(),callback);},
        destroy(error,callback){Promise.resolve(file?.close()).then(()=>callback(error),callback);},
    });
}
async function readFile(path){
    if(!native.enabled())return fs.readFile(path);
    const file=await open(path,'r');
    try{const {size}=await file.stat();const output=Buffer.alloc(size);let at=0;
        while(at<size){const {bytesRead}=await file.read(output,at,Math.min(1024*1024,size-at),at);if(!bytesRead)throw new Error('Incomplete media file');at+=bytesRead;}return output;
    }finally{await file.close();}
}
async function writeFile(path,bytes){if(!native.enabled())return fs.writeFile(path,bytes);const file=await open(path,'w');try{for(let at=0;at<bytes.length;at+=1024*1024)await file.writeFile(bytes.subarray(at,at+1024*1024));}finally{await file.close();}}
module.exports={...fs,open,createReadStream,createWriteStream,readFile,writeFile,
    stat:async path=>native.enabled()?metadata(await call('stat',{path})):fs.stat(path),
    mkdtemp:async path=>native.enabled()?call('mkdtemp',{path}):fs.mkdtemp(path),
    mkdir:async(path,options)=>native.enabled()?call('mkdir',{path}):fs.mkdir(path,options),
    rm:async(path,options)=>native.enabled()?call('rm',{path}):fs.rm(path,options),
    readdir:async(path,options)=>{
        if(!native.enabled())return fs.readdir(path,options);
        const entries=await call('readdir',{path});return options?.withFileTypes?entries.map(e=>({name:e.name,isDirectory:()=>e.directory})):entries.map(e=>e.name);
    },
};
