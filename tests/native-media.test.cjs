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
test('Rust rejects out-of-order GIF frames',async()=>{
 const handle=(await native.service().call('gif_new',{width:1,height:1,fps:15})).value;
 try{await assert.rejects(native.service().call('gif_frame',{handle,index:0},Buffer.alloc(4)));await native.service().call('gif_sample',{handle},Buffer.alloc(4));await native.service().call('gif_start',{handle});await assert.rejects(native.service().call('gif_frame',{handle,index:2},Buffer.alloc(4)));}finally{await native.service().call('gif_close',{handle});}
});
