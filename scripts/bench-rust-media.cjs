// Includes the binary IPC overhead for every migrated operation. Combined score
// is one explicitly defined fixture workload, not a claim about normal app use.
const {performance}=require('node:perf_hooks');
const {resolve,join}=require('node:path');
const fs=require('node:fs/promises');
const {readFileSync}=require('node:fs');
const {tmpdir,cpus}=require('node:os');
const assert=require('node:assert/strict');
const {Worker}=require('node:worker_threads');
const native=require('../electron/native-media.cjs');
const {sanitizeNativeImage}=require('../electron/native-image.cjs');
const {pngChunk}=require('../electron/privacy-files.cjs');
const {zipBuilder,gifWorkload,bridge}=require('../tests/helpers/native-media.cjs');
const root=resolve(__dirname,'..'),baseline=process.argv[2]??'/tmp/lowcord-rust-baseline';
const executable=resolve('src-tauri/target/release',`lowcord-native${process.platform==='win32'?'.exe':''}`);
native.configure(executable);
const median=a=>a.slice().sort((a,b)=>a-b)[Math.floor(a.length/2)];
const jsImage=bytes=>new Promise((resolve,reject)=>{const w=new Worker(join(root,'electron/privacy-worker.cjs'));w.once('error',reject);w.once('message',async r=>{await w.terminate();resolve(r);});w.postMessage(bytes);});
async function main(){
 const directory=await fs.mkdtemp(join(tmpdir(),'lowcord-all-bench-'));
 const build=zipBuilder(),archive=build(Array.from({length:5000},(_,i)=>({name:`folder/item-${i}.txt`,data:`Content ${i}`})));
 const zipWindow={Lowcord:{}};new Function('window',readFileSync('src-tauri/injection/zip-preview.js','utf8'))(zipWindow);
 const zip=zipWindow.Lowcord.zipPreview,found=zip.findDirectory(archive.subarray(-65536)),central=archive.subarray(found.offset,found.offset+found.size);
 const zipPath=join(directory,'archive.zip');await fs.writeFile(zipPath,archive);
 // Valid PNG with a large compressed pixel payload and an ancillary text chunk.
 const pixels=require('node:crypto').randomFillSync(Buffer.alloc(8*1024*1024));
 const width=1024,height=Math.floor(pixels.length/(width*4+1));const raw=pixels.subarray(0,height*(width*4+1));for(let i=0;i<height;i++)raw[i*(width*4+1)]=0;
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
 const image=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),pngChunk('IHDR',ihdr),pngChunk('tEXt',Buffer.from('Author\0Private')),pngChunk('IDAT',require('node:zlib').deflateSync(raw,{level:1})),pngChunk('IEND',Buffer.alloc(0))]);
 const fixture=require('../tests/fixtures/reddit-playback.cjs').createRedditFixture(root,{clipMiB:64});
 const video=join(directory,'video.mp4'),audio=join(directory,'audio.mp4');await fs.writeFile(video,Buffer.from(await(await fixture.fetchPage('https://v.redd.it/abc/DASH_480.mp4')).arrayBuffer()));await fs.writeFile(audio,fixture.audio);
 const jsMux=require(join(baseline,'electron/mp4-mux.cjs')).muxToFile;
 let serial=0;
 const storage=async impl=>{
  const io=fs;
  const dir=await io.mkdtemp(join(directory,'storage-'));try{const file=await io.open(join(dir,'clip'),'wx');const chunk=Buffer.alloc(1024*1024,42);try{for(let i=0;i<32;i++)await file.write(chunk);}finally{await file.close();}
   const input=await io.open(join(dir,'clip'),'r');try{for(let offset=0;offset<32*1024*1024;offset+=chunk.length){const r=await input.read(chunk,0,chunk.length,offset);assert.equal(r.bytesRead,chunk.length);}}finally{await input.close();}
  }finally{await io.rm(dir,{recursive:true,force:true});}
 };
 const gif={javascript:gifWorkload(),rust:gifWorkload(bridge)};
 const tasks={
  image:async impl=>{const r=await(impl==='rust'?sanitizeNativeImage(executable,image):jsImage(image));assert.equal(r.status,'processed');},
  gif:async impl=>{const bytes=await gif[impl].encode({size:240});assert.equal(Buffer.from(bytes).toString('ascii',0,6),'GIF89a');},
  mp4:async impl=>{const output=join(directory,`mux-${serial++}`);try{await jsMux(video,audio,output);}finally{await fs.rm(output,{force:true});}},
  attachmentZip:async impl=>{const r=await require(join(baseline,'electron/privacy-files.cjs')).inspectPath(zipPath,'archive.zip');assert.equal(r.status,'checked');},
  zipPreview:async impl=>{const r=zip.parseEntries(central,found.count);assert.equal(r.entries.length,5000);},
  storage,
 };
 const rows=[];
 try{
  for(const [task,run]of Object.entries(tasks)){
   const times={javascript:[],rust:[]};for(let i=-2;i<11;i++)for(const impl of i%2?['javascript','rust']:['rust','javascript']){const start=performance.now();await run(impl);if(i>=0)times[impl].push(performance.now()-start);}
   const row={task,jsMs:median(times.javascript),rustMs:median(times.rust),speedup:median(times.javascript)/median(times.rust),samples:times};rows.push(row);console.log(JSON.stringify(row));
  }
  const combined={javascript:[],rust:[]};for(let i=0;i<7;i++)for(const impl of i%2?['javascript','rust']:['rust','javascript']){const start=performance.now();for(const run of Object.values(tasks))await run(impl);combined[impl].push(performance.now()-start);}
  const result={at:new Date().toISOString(),cpu:cpus()[0].model,platform:process.platform,arch:process.arch,node:process.version,iterations:11,warmups:2,baseline,
    workload:'8 MiB valid PNG; 30 GIF frames at 240x135; 64 MiB MP4 remux; 5000-entry ZIP inspection and preview; 32 MiB write/read/delete in 1 MiB chunks. Alternating implementations, release Rust, IPC included. Microbenchmark GIF frames are synthetic RGBA with identical output; browser decoding excluded. Selective variant keeps MP4/archive/storage in JavaScript. Shared Rust GIF service warmed; MP4 and image job launches included.',retainedNativeOperations:['image','gif'],rows,
    combined:{jsMs:median(combined.javascript),rustMs:median(combined.rust),speedup:median(combined.javascript)/median(combined.rust),samples:combined}};
  await fs.writeFile('output/rust-selective-media-benchmark.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result.combined));
 }finally{native.close();await fs.rm(directory,{recursive:true,force:true});}
}
main().catch(e=>{native.close();console.error(e);process.exitCode=1;});
