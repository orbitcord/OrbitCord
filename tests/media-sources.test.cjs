const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,rm,readFile,writeFile,readdir}=require('node:fs/promises');
const {join}=require('node:path');const {tmpdir}=require('node:os');
const {createSourceFiles,publicURL,publicAddress,identify,CHUNK,requestReferer}=require('../electron/media-source-files.cjs');
const {SOURCES,sourceAllows}=require('../electron/media-sources.cjs');
const sample=readFile(join(__dirname,'fixtures/media/sample.mp4'));
async function fixture(t,options={}){
    const directory=await mkdtemp(join(tmpdir(),'source-files-test-'));
    const service=createSourceFiles({directory,validateURL:async value=>{const url=new URL(value);if(url.hostname!=='media.example.test')throw Object.assign(new Error('invalid-url'),{code:'invalid-url'});return url.href;},...options});
    t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true});});
    return {service,directory};
}
const input=(fetch,extra={})=>({url:'https://media.example.test/clip.mp4',referer:'https://media.example.test/page',limit:20_000_000,channelId:'dm',source:'shorts',fetch,...extra});

test('all eight source adapters constrain navigation to their own HTTPS domains',()=>{
    assert.deepEqual(SOURCES.map(s=>s.id),['gifreels','erome','sexcom','imagefap','xxxfollow','xxxtik','shorts','xfree']);
    for(const source of SOURCES){assert.equal(sourceAllows(source,source.home),true);assert.equal(sourceAllows(source,source.home.replace('https:','http:')),false);assert.equal(sourceAllows(source,'https://discord.com/channels/@me'),false);assert.equal(sourceAllows(source,'file:///etc/passwd'),false);assert.equal(sourceAllows(source,`https://${new URL(source.home).hostname}.evil.test/`),false);}
});
test('media URLs reject local networks, non-HTTPS URLs, ports and credentials',async()=>{
    for(const ip of ['127.0.0.1','10.1.2.3','192.168.1.1','172.16.1.1','169.254.169.254','100.64.1.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1'])assert.equal(publicAddress(ip),false,ip);
    assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700::1111'),true);
    for(const url of ['http://example.com/a','https://user:pass@example.com/a','https://example.com:8443/a','https://127.0.0.1/a','https://[::1]/a','file:///tmp/a','data:text/html,x','https://server.local/a'])await assert.rejects(publicURL(url));
    assert.throws(()=>identify(Buffer.from('<html>not a video</html>')),{code:'unsupported-media'});
    assert.deepEqual(identify(Buffer.concat([Buffer.alloc(4),Buffer.from('ftypavif')])),{type:'image/avif',ext:'avif'});
});
test('direct source files retain bytes and MIME, read in bounded owner-scoped chunks, and release cleans disk',async t=>{
    const {service,directory}=await fixture(t);const bytes=await sample;
    const result=await service.prepare(1,input(async(_url,init)=>{assert.equal(init.redirect,'manual');assert.equal(init.credentials,'include');assert.equal(init.headers.Referer,'https://media.example.test/page');return new Response(bytes);}));
    assert.equal(result.type,'video/mp4');assert.equal(result.size,bytes.length);
    await assert.rejects(service.read(2,result.id,0),{code:'expired'});
    assert.deepEqual(Buffer.from(await service.read(1,result.id,0)),bytes);
    await assert.rejects(service.read(1,result.id,-1),{code:'invalid-read'});
    await service.release(2,result.id);assert.equal((await service.read(1,result.id,0)).length,bytes.length);
    await service.release(1,result.id);await assert.rejects(service.read(1,result.id,0),{code:'expired'});
    assert.deepEqual(await readdir(join(directory,(await readdir(directory))[0])),[]);
});
test('redirects are revalidated and HTML/auth failures cannot become attachments',async t=>{
    const {service}=await fixture(t);
    await assert.rejects(service.prepare(1,input(async()=>new Response(null,{status:302,headers:{location:'https://127.0.0.1/private'}}))),{code:'invalid-url'});
    await assert.rejects(service.prepare(1,input(async()=>new Response('<html>sign in</html>',{status:403}))),{code:'access-denied'});
    await assert.rejects(service.prepare(1,input(async()=>new Response('<html>not media</html>'))),{code:'unsupported-media'});
    await assert.rejects(service.prepare(1,input(async()=>new Response(null,{headers:{'content-length':String(3*1024**3)}}))),{code:'too-large'});
});
test('oversized videos use the shared converter and validate the result against the requested cap',async t=>{
    let conversions=0;const bytes=await sample;
    const {service}=await fixture(t,{compress:async(path,directory,limit,signal,options)=>{
        conversions++;assert.equal(limit,20_000_000);assert.equal(options.general,true);signal.throwIfAborted();
        const out=join(directory,'compressed.mp4');await writeFile(out,bytes);return out;
    }});
    const stream=new ReadableStream({start(controller){controller.enqueue(bytes);for(let i=0;i<20;i++)controller.enqueue(new Uint8Array(CHUNK));controller.close();}});
    const result=await service.prepare(1,input(async()=>new Response(stream)));
    assert.equal(conversions,1);assert.equal(result.size,bytes.length);await service.release(1,result.id);
});
test('protected, live and separate-audio playlists fail explicitly without fetching their media',async t=>{
    const {service}=await fixture(t);
    for(const [text,code] of [
        ['#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXT-X-ENDLIST','protected-stream'],
        ['#EXTM3U\n#EXTINF:2,\nsegment.ts','unsupported-stream'],
        ['#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,AUDIO="audio"\nvideo.m3u8','separate-audio'],
    ]){let calls=0;await assert.rejects(service.prepare(1,input(async()=>{calls++;return new Response(text);},{url:'https://media.example.test/master.m3u8'})),{code});assert.equal(calls,1);}
});
test('a finite unencrypted HLS playlist becomes a valid MP4 using local files only',async t=>{
    const {promisify}=require('node:util');const {execFile}=require('node:child_process');
    const temp=await mkdtemp(join(tmpdir(),'source-hls-'));t.after(()=>rm(temp,{recursive:true,force:true}));
    const path=join(temp,'segment.ts');await promisify(execFile)('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',join(__dirname,'fixtures/media/sample.mp4'),'-c','copy','-f','mpegts',path]);
    const segment=await readFile(path);const {service}=await fixture(t);
    const result=await service.prepare(1,input(async url=>new Response(url.endsWith('.m3u8')?'#EXTM3U\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST':segment),{url:'https://media.example.test/index.m3u8'}));
    const data=Buffer.from(await service.read(1,result.id,0));assert.equal(data.toString('ascii',4,8),'ftyp');assert.equal(result.type,'video/mp4');assert.ok(result.size<20_000_000);
});
test('cancelling an in-flight source download removes temporary input and frees the owner',async t=>{
    const {service}=await fixture(t);let started;const begun=new Promise(resolve=>{started=resolve;});
    const pending=service.prepare(1,input(async(_url,init)=>{started();return new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));}));
    const rejected=assert.rejects(pending);await begun;await service.cancel(1);await rejected;
    const result=await service.prepare(1,input(async()=>new Response(await sample)));await service.release(1,result.id);
});
test('cancellation while URL validation is pending prevents a later download',async t=>{
    let resolveValidation;const blocked=new Promise(resolve=>{resolveValidation=resolve;});let downloaded=false;
    const {service}=await fixture(t,{validateURL:async value=>{await blocked;return value;}});
    const pending=service.prepare(1,input(async()=>{downloaded=true;return new Response(await sample);}));
    const rejected=assert.rejects(pending,{code:'cancelled'});
    await service.cancel(1);await rejected;resolveValidation();
    await new Promise(resolve=>setImmediate(resolve));assert.equal(downloaded,false);
});
test('the shared local converter turns animated GIF input into an MP4',async t=>{
    const {promisify}=require('node:util');const {execFile}=require('node:child_process');
    const {compressVideo}=require('../electron/video-compress.cjs');
    const directory=await mkdtemp(join(tmpdir(),'source-gif-'));t.after(()=>rm(directory,{recursive:true,force:true}));
    const input=join(directory,'animation.gif');
    await promisify(execFile)('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',join(__dirname,'fixtures/media/sample.mp4'),'-vf','scale=64:36,fps=8','-t','1',input]);
    const output=await compressVideo(input,directory,120_000,new AbortController().signal,{general:true});
    const bytes=await readFile(output);assert.equal(bytes.toString('ascii',4,8),'ftyp');assert.ok(bytes.length<120_000);
});

test('cross-origin media requests use an origin referrer compatible with Chromium policy',async t=>{
    assert.equal(requestReferer('https://site.example/watch/one#play','https://cdn.example/clip.mp4'),'https://site.example/');
    assert.equal(requestReferer('https://site.example/watch/one#play','https://site.example/clip.mp4'),'https://site.example/watch/one');
    const {service}=await fixture(t,{validateURL:async value=>value});let header;
    const result=await service.prepare(1,input(async(_url,init)=>{header=init.headers.Referer;return new Response(await sample);},{referer:'https://page.example.test/watch/one'}));
    assert.equal(header,'https://page.example.test/');await service.release(1,result.id);
});
test('separate-audio HLS playlists with EXT-X-MEDIA audio URI mux video and audio locally',async t=>{
    const vBytes=await readFile(join(__dirname,'fixtures/media/dash-video.mp4'));
    const aBytes=await readFile(join(__dirname,'fixtures/media/dash-audio.mp4'));
    const {service}=await fixture(t);
    const routes={
        'https://media.example.test/master.m3u8':'#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="program_audio_0",NAME="audio_0",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1200000,AUDIO="program_audio_0"\nvideo.m3u8',
        'https://media.example.test/video.m3u8':'#EXTM3U\n#EXTINF:2,\nvideo.cmfv\n#EXT-X-ENDLIST',
        'https://media.example.test/audio.m3u8':'#EXTM3U\n#EXTINF:2,\naudio.cmfa\n#EXT-X-ENDLIST',
        'https://media.example.test/video.cmfv':vBytes,
        'https://media.example.test/audio.cmfa':aBytes,
    };
    const result=await service.prepare(1,input(async url=>new Response(routes[url]),{url:'https://media.example.test/master.m3u8'}));
    const data=Buffer.from(await service.read(1,result.id,0));
    assert.equal(data.toString('ascii',4,8),'ftyp');
    assert.equal(result.type,'video/mp4');
    await service.release(1,result.id);
});

