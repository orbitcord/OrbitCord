const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const {resolve,join}=require('node:path');
const fs=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {readFileSync}=require('node:fs');
const native=require('../electron/native-media.cjs');
const {zipBuilder,gifWorkload,bridge}=require('./helpers/native-media.cjs');
native.configure(resolve('src-tauri/target/release',`lowcord-native${process.platform==='win32'?'.exe':''}`));
after(()=>native.close());
test('Rust and JS GIF encoders produce identical bytes, including palette generation, changed frames and LZW',async()=>{
 for(const size of [48,240]){const js=gifWorkload(),rust=gifWorkload(bridge);const expected=await js.encode({size}),actual=await rust.encode({size});assert.deepEqual(Buffer.from(actual),Buffer.from(expected));}
});
test('Rust and JS MP4 mux produce identical files and refuse malformed input',async()=>{
 const dir=await fs.mkdtemp(join(tmpdir(),'lowcord-mux-test-'));
 try{const video=resolve('tests/fixtures/media/dash-video.mp4'),audio=resolve('tests/fixtures/media/dash-audio.mp4');
 const expected=require('../electron/mp4-mux.cjs').mux(readFileSync(video),readFileSync(audio));const output=join(dir,'mux.mp4');await native.mux(video,audio,output);assert.deepEqual(await fs.readFile(output),expected);
 await assert.rejects(native.mux(video,audio,output));assert.deepEqual(await fs.readFile(output),expected);
 const broken=join(dir,'broken');await fs.writeFile(broken,Buffer.from('not mp4'));await assert.rejects(native.mux(broken,audio,join(dir,'bad')));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('Rust ZIP preview, inflate and attachment reports match baseline',async()=>{
 const build=zipBuilder();const input=build([{name:'café.txt',utf8:true,data:'hello world'},{name:'../run.ps1',data:'code'},{name:Buffer.from([0x82,46,116,120,116]),data:'cp437'}]);
 const win={Lowcord:{}};new Function('window',readFileSync('src-tauri/injection/zip-preview.js','utf8'))(win);const zip=win.Lowcord.zipPreview;
 const dir=zip.findDirectory(input.subarray(-Math.min(input.length,65536)));const bytes=input.subarray(dir.offset,dir.offset+dir.size);
 assert.deepEqual((await native.service().call('zip_directory',{count:dir.count},bytes)).value,zip.parseEntries(bytes,dir.count));
 const entry=zip.parseEntries(bytes,dir.count).entries[0];const range=async(a,b)=>input.subarray(a,b+1);const expected=await zip.readEntry(range,entry);const start=entry.offset+30+input.readUInt16LE(entry.offset+26)+input.readUInt16LE(entry.offset+28);assert.deepEqual((await native.service().call('zip_inflate',{},input.subarray(start,start+entry.compressed))).bytes,Buffer.from(expected));
 const directory=await fs.mkdtemp(join(tmpdir(),'lowcord-inspect-test-'));try{for(const [name,data]of [['archive.zip',input],['photo.png',Buffer.from('not an image')],['invoice.pdf.exe',Buffer.from('MZ data')],['notes.txt',Buffer.from('café')]]){const path=join(directory,name);await fs.writeFile(path,data);
 const baseline=await require('../electron/privacy-files.cjs').inspectAttachment({name,size:data.length,read:async(a,n)=>data.subarray(a,a+n)});const actual=(await native.service().call('inspect',{path,name})).value;assert.deepEqual(actual,baseline);}}
 finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('Rust inspection matches every existing attachment and archive behavior case',async()=>{
 const directory=await fs.mkdtemp(join(tmpdir(),'lowcord-inspection-corpus-'));
 try{const cases=await require('./helpers/image-corpus.cjs').inspectionCorpus();
  for(let i=0;i<cases.length;i++) {const {name,bytes,expected}=cases[i],path=join(directory,String(i));await fs.writeFile(path,bytes);
   const actual=(await native.service().call('inspect',{path,name})).value;
   assert.deepEqual(actual,JSON.parse(JSON.stringify(expected)),name);
  }
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('Rust bounds decompression and rejects out-of-order GIF frames',async()=>{
 const zipped=require('node:zlib').deflateRawSync(Buffer.alloc(3*1024*1024));await assert.rejects(native.service().call('zip_inflate',{},zipped),/Too large/);
 const handle=(await native.service().call('gif_new',{width:1,height:1,fps:15})).value;
 try{await assert.rejects(native.service().call('gif_frame',{handle,index:0},Buffer.alloc(4)));await native.service().call('gif_sample',{handle},Buffer.alloc(4));await native.service().call('gif_start',{handle});await assert.rejects(native.service().call('gif_frame',{handle,index:2},Buffer.alloc(4)));}finally{await native.service().call('gif_close',{handle});}
});
