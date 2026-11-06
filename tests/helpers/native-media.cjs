const {readFileSync}=require('node:fs');
const path=require('node:path');
const {createRequire}=require('node:module');
const {runInNewContext}=require('node:vm');
const native=require('../../electron/native-media.cjs');
function zipBuilder(){
 const file=path.resolve(__dirname,'../zip-preview.test.cjs');const local=createRequire(file);const module={exports:{}};
 runInNewContext(readFileSync(file,'utf8')+'\nmodule.exports = {build};',{Buffer,Uint8Array,TextDecoder,DataView,DecompressionStream,Blob,Response,__dirname:path.dirname(file),module,require:name=>name==='node:test'?{test:()=>{}}:local(name)});
 return module.exports.build;
}
function gifEncoder(bridge) {
 const window={Lowcord:{},__LOWCORD_NATIVE__:bridge?{mediaProcess:bridge}:undefined};
 const video=new EventTarget();Object.assign(video,{videoWidth:240,videoHeight:135,duration:2});let time=0;
 Object.defineProperty(video,'currentTime',{get:()=>time,set:v=>{time=v;queueMicrotask(()=>video.dispatchEvent(new Event('seeked')));}});
 const frames=new Map();const context={drawImage(){},fillRect(){},getImageData(_x,_y,width,height){
  const index=Math.round(time*15),key=`${width}x${height}:${index}`;
  if(!frames.has(key)) {const data=new Uint8ClampedArray(width*height*4);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const p=(y*width+x)*4;data[p]=(x*3+index*9)&255;data[p+1]=(y*5+index*7)&255;data[p+2]=((x^y)*3+index*5)&255;data[p+3]=255;}frames.set(key,data);}
  return {data:frames.get(key)};
 }};
 const document={createElement:()=>({getContext:()=>context})};
 const source=readFileSync(path.resolve(__dirname,'../../src-tauri/injection/gif.js'),'utf8').replace('    window.Lowcord.gif =','    window.__encode = encode;\n    window.Lowcord.gif =');
 new Function('window','document',source)(window,document);
 return { encode: (options={})=>window.__encode(video,{size:options.size??240,fps:15},32*1024*1024,
  // Get the existing JS dictionary through a test-only export.
  window.__lzw,options.compose), window,video, source,document };
}
// Expose the actual baseline dictionary without duplicating its implementation.
function gifWorkload(bridge) {
 const made=gifEncoder(bridge);
 const source=made.source.replace('    window.__encode = encode;','    window.__lzw = createLzw();\n    window.__encode = encode;');
 // Native runs must not allocate the baseline's 6 MiB dictionary.
 new Function('window','document',bridge?made.source:source)(made.window,made.document);
 return made;
}
async function bridge(op,args,bytes){const result=await native.service().call(op,args,bytes);return op==='gif_new'?result.value:result.bytes;}
module.exports={zipBuilder,gifWorkload,bridge};
