// Read a file-backed blob from its own isolated source page. MediaSource/DRM
// URLs are not fetchable and fail normally. No page gets a native bridge.
const WORLD=1007;
async function sourceBlobResponse(wc,url,signal){
    const page=new URL(wc.getURL()),origin=new URL(url.slice(5));
    if(!url.startsWith('blob:')||origin.origin!==page.origin||!/^https?:$/.test(page.protocol))throw Object.assign(new Error('unresolved-media'),{code:'unresolved-media'});
    const run=code=>wc.executeJavaScriptInIsolatedWorld(WORLD,[{code}]);
    let aborted=false;
    const abort=()=>{aborted=true;if(!wc.isDestroyed())void run('globalThis.__lcSourceBlob?.abort.abort();globalThis.__lcSourceBlob?.reader?.cancel().catch(()=>{});delete globalThis.__lcSourceBlob;').catch(()=>{});};
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted){abort();throw signal.reason;}
    try{
        await run(`(async()=>{globalThis.__lcSourceBlob?.abort.abort();const abort=new AbortController();globalThis.__lcSourceBlob={abort};const response=await fetch(${JSON.stringify(url)},{signal:abort.signal});if(!response.ok||!response.body)throw Error('unresolved-media');globalThis.__lcSourceBlob.reader=response.body.getReader();})()`);
        if(aborted)throw signal.reason;
    }catch(error){signal.removeEventListener('abort',abort);abort();console.warn('[media-sources] blob read failed:',String(error.message).slice(0,100));throw Object.assign(new Error('unsupported-blob'),{code:'unsupported-blob'});}
    const cleanup=()=>{signal.removeEventListener('abort',abort);abort();};
    return new Response(new ReadableStream({
        async pull(controller){
            try{
                signal.throwIfAborted();if(wc.isDestroyed())throw new Error('cancelled');
                const result=await run(`(async()=>{const state=globalThis.__lcSourceBlob;if(!state?.reader)throw Error('cancelled');let bytes=state.pending;if(!bytes?.length){const result=await state.reader.read();if(result.done)return null;bytes=result.value;}const part=bytes.subarray(0,262144);state.pending=bytes.subarray(part.length);return Array.from(part);})()`);
                signal.throwIfAborted();
                if(result===null){cleanup();controller.close();}else controller.enqueue(Uint8Array.from(result));
            }catch(error){cleanup();controller.error(error);}
        },cancel(){cleanup();},
    }),{headers:{'Content-Type':'application/octet-stream'}});
}
module.exports={sourceBlobResponse};
