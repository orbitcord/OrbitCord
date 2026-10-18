const { randomBytes } = require('node:crypto');
const { lookup } = require('node:dns/promises');
const { isIP } = require('node:net');
const { mkdtemp, open, rm, stat, readdir } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { compressVideo } = require('./video-compress.cjs');
const fail = code => Object.assign(new Error(code), { code });
const CHUNK = 1024 * 1024, MAX_SOURCE = 2 * 1024 ** 3;

function publicAddress(value) {
    if (isIP(value) === 6) return /^[23]/i.test(value) && !/^2001:db8:/i.test(value);
    if (isIP(value) !== 4) return false;
    const [a,b,c] = value.split('.').map(Number);
    return a > 0 && a < 224 && ![10,127].includes(a) && !(a === 169 && b === 254)
        && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || b === 0))
        && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && [18,19,51].includes(b))
        && !(a === 203 && b === 0 && c === 113);
}
async function publicURL(value) {
    if (typeof value !== 'string' || value.length > 16_384) throw fail('invalid-url');
    let url; try { url = new URL(value); } catch { throw fail('invalid-url'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || /(?:^|\.)(?:localhost|local|internal|lan)$/.test(url.hostname)) throw fail('invalid-url');
    const host = url.hostname.replace(/^\[|\]$/g,'');
    let timer;
    const addresses = isIP(host) ? [{ address: host }] : await Promise.race([
        lookup(host, { all: true }),new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail('lookup-timeout')),15_000);}),
    ]).finally(()=>clearTimeout(timer));
    if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw fail('invalid-url');
    return url.href;
}
function identify(bytes) {
    if (bytes.length >= 12 && bytes.toString('ascii',4,8) === 'ftyp') {
        const brand=bytes.toString('ascii',8,12);
        if(['avif','avis'].includes(brand))return {type:'image/avif',ext:'avif'};
        if(['heic','heix','hevc','mif1','msf1','M4A '].includes(brand))throw fail('unsupported-media');
        return { type: 'video/mp4', ext: 'mp4', convert: brand === 'qt  ' };
    }
    if (bytes.subarray(0,4).equals(Buffer.from('1a45dfa3','hex'))) return { type: 'video/webm', ext: 'webm', convert: true };
    if (bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) return { type: 'image/png', ext: 'png' };
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { type: 'image/jpeg', ext: 'jpg' };
    if (/^GIF8[79]a/.test(bytes.toString('ascii',0,6))) return { type: 'image/gif', ext: 'gif', animated: true };
    if (bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') return { type: 'image/webp', ext: 'webp', animated: bytes.includes(Buffer.from('ANIM')) };
    throw fail('unsupported-media');
}
function extractWebpFrame(b) {
    if (b.length < 30 || b.toString('ascii',0,4) !== 'RIFF' || b.toString('ascii',8,12) !== 'WEBP') return null;
    let off = 12;
    while (off + 8 <= b.length) {
        const fourcc = b.toString('ascii',off,off+4), size = b.readUInt32LE(off+4), payload = off + 8;
        if (fourcc === 'ANMF') {
            if (payload + size > b.length) return null;
            let sub = payload + 16;
            while (sub + 8 <= payload + size) {
                const sc = b.toString('ascii',sub,sub+4), ss = b.readUInt32LE(sub+4), pad = ss + (ss & 1);
                if ((sc === 'VP8 ' || sc === 'VP8L') && sub + 8 + ss <= payload + size) {
                    const chunk = b.subarray(sub, Math.min(sub + 8 + pad, payload + size));
                    const out = Buffer.alloc(12 + chunk.length);
                    out.write('RIFF',0,'ascii'); out.writeUInt32LE(4 + chunk.length,4); out.write('WEBP',8,'ascii');
                    chunk.copy(out,12); return out;
                }
                sub += 8 + pad;
            }
            return null;
        }
        off = payload + size + (size & 1);
    }
    return null;
}
function requestReferer(page,value){
    const referer=new URL(page),target=new URL(value);referer.hash='';
    return referer.origin===target.origin?referer.href:referer.origin+'/';
}
function createSourceFiles({ directory = tmpdir(), validateURL = publicURL, compress = compressVideo } = {}) {
    const jobs = new Map(); let root, closed = false;
    async function folder() {
        return root ??= (async () => {
            for (const entry of await readdir(directory, { withFileTypes: true })) {
                const match = /^orbitcord-source-(\d+)-/.exec(entry.name);
                if (!entry.isDirectory() || !match || Number(match[1]) === process.pid) continue;
                try { process.kill(Number(match[1]),0); } catch (error) {
                    if (error.code === 'ESRCH') await rm(join(directory,entry.name),{recursive:true,force:true});
                }
            }
            return mkdtemp(join(directory,`orbitcord-source-${process.pid}-`));
        })();
    }
    function touch(job) {
        clearTimeout(job.timer);
        job.timer = setTimeout(() => void release(job.owner,job.id), job.state === 'ready' ? 300_000 : 1_200_000);
        job.timer.unref?.();
    }
    const get = (owner,id) => { const job = jobs.get(id); if (!job || job.owner !== owner || job.controller.signal.aborted) throw fail('expired'); touch(job); return job; };
    async function checkedURL(job,value){
        const signal=job.controller.signal;signal.throwIfAborted();let abort;
        try{return await Promise.race([Promise.resolve().then(()=>validateURL(value)),new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});})]);}
        finally{signal.removeEventListener('abort',abort);}
    }
    async function request(job, value, headers = {}) {
        let url = value;
        for (let redirects = 0; redirects < 6; redirects++) {
            url = await checkedURL(job,url);
            job.controller.signal.throwIfAborted();
            let response;
            for (let attempt = 0; ; attempt++) {
                const reqAbort = new AbortController();
                const timer = setTimeout(() => reqAbort.abort(fail('lookup-timeout')), 30_000);
                timer.unref?.();
                try {
                    response = await job.fetch(url, { redirect: 'manual', credentials: 'include',
                        // Chromium rejects a manual Referer that conflicts with its default
                        // strict-origin-when-cross-origin policy. Same-site fixtures hid
                        // this: real source files live on a different CDN origin.
                        headers: { Referer: requestReferer(job.referer,url), ...headers },
                        signal: AbortSignal.any([job.controller.signal, reqAbort.signal]) });
                    clearTimeout(timer);
                    break;
                } catch (err) {
                    clearTimeout(timer);
                    if (job.controller.signal.aborted || attempt >= 2) throw err;
                    await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
                }
            }
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location'); await response.body?.cancel();
                if (!location) throw fail('invalid-redirect'); url = new URL(location,url).href; continue;
            }
            if (!response.ok) { await response.body?.cancel(); throw fail([401,403].includes(response.status) ? 'access-denied' : `http-${response.status}`); }
            return { response, url };
        }
        throw fail('too-many-redirects');
    }
    async function small(job,value) {
        const { response,url } = await request(job,value);
        let size = 0; const parts = [];
        try { for await (const bytes of response.body) { size += bytes.length; if (size > CHUNK) throw fail('invalid-playlist'); parts.push(bytes); } }
        catch(error) { await response.body?.cancel().catch(()=>{}); throw error; }
        return { text: Buffer.concat(parts).toString('utf8'), url };
    }
    async function writeResponse(job,response,file) {
        const declared = Number(response.headers.get('content-length'));
        if (declared > MAX_SOURCE - job.downloaded) { await response.body?.cancel(); throw fail('too-large'); }
        let stallTimer;
        const resetStall = () => {
            clearTimeout(stallTimer);
            stallTimer = setTimeout(() => job.controller.abort(fail('lookup-timeout')), 45_000);
            stallTimer.unref?.();
        };
        resetStall();
        try {
            for await (const bytes of response.body) {
                resetStall();
                job.downloaded += bytes.length;
                if (job.downloaded > MAX_SOURCE) throw fail('too-large');
                let offset = 0;
                while (offset < bytes.length) {
                    const result = await file.write(bytes,offset,bytes.length-offset);
                    if (!result.bytesWritten) throw fail('write-failed'); offset += result.bytesWritten;
                }
            }
        } finally { clearTimeout(stallTimer); }
    }
    async function playlist(job,value,file,depth=0) {
        if (depth > 3) throw fail('invalid-playlist');
        const {text,url} = await small(job,value);
        if (!text.trimStart().startsWith('#EXTM3U')) throw fail('invalid-playlist');
        const lines = text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
        if(lines.some(line=>/^#EXT-X-(?:KEY|SESSION-KEY):/.test(line)&&!/^#EXT-X-(?:KEY|SESSION-KEY):METHOD=NONE(?:,|$)/.test(line)))throw fail('protected-stream');
        const audioGroups = new Map();
        for (const line of lines) if (/^#EXT-X-MEDIA:/i.test(line) && /\bTYPE=AUDIO\b/i.test(line)) {
            const group = /\bGROUP-ID="([^"]+)"/i.exec(line)?.[1];
            const uri = /\bURI="([^"]+)"/i.exec(line)?.[1];
            if (group && uri && (!audioGroups.has(group) || /\bDEFAULT=YES\b/i.test(line))) {
                audioGroups.set(group, new URL(uri, url).href);
            }
        }
        const variants = [];
        for (let i=0;i<lines.length;i++) if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
            let audioUrl = null;
            if (/\bAUDIO=/.test(lines[i])) {
                const group = /\bAUDIO="([^"]+)"/i.exec(lines[i])?.[1] || /\bAUDIO=([^\s,]+)/i.exec(lines[i])?.[1]?.replace(/^"|"$/g, '');
                audioUrl = group ? audioGroups.get(group) : null;
                if (!audioUrl) throw fail('separate-audio');
            }
            if (lines[i+1] && !lines[i+1].startsWith('#')) variants.push({ url:new URL(lines[i+1],url).href,rate:Number(/BANDWIDTH=(\d+)/.exec(lines[i])?.[1])||0,audioUrl });
        }
        if (variants.length) {
            const under = variants.filter(v => v.rate > 0 && v.rate <= 2_800_000).sort((a, b) => b.rate - a.rate);
            const chosen = under[0] || variants.sort((a, b) => (a.rate || Infinity) - (b.rate || Infinity))[0];
            if (chosen.audioUrl && !job.audioInput) {
                const audioPath = join(job.folder, 'input.audio');
                const audioFile = await open(audioPath, 'wx', 0o600);
                try { await playlist(job, chosen.audioUrl, audioFile, depth + 1); job.audioInput = audioPath; }
                finally { await audioFile.close(); }
            }
            return playlist(job, chosen.url, file, depth+1);
        }
        if (!lines.includes('#EXT-X-ENDLIST') || lines.some(line=>/^#EXT-X-(?:BYTERANGE|DISCONTINUITY|GAP)/.test(line))) throw fail('unsupported-stream');
        const segments = [];
        for (const line of lines) {
            if (line.startsWith('#EXT-X-MAP:')) {
                const map = /URI="([^"]+)"/.exec(line)?.[1];
                if (!map || /BYTERANGE/.test(line)) throw fail('unsupported-stream');
                segments.push(new URL(map,url).href);
            } else if (!line.startsWith('#')) segments.push(new URL(line,url).href);
        }
        if (!segments.length || segments.length > 4096) throw fail('invalid-playlist');
        for (const segment of segments) { const {response} = await request(job,segment); await writeResponse(job,response,file); }
    }
    async function prepare(owner,{url,referer,limit,source,channelId,fetch:fetchPage,onState=()=>{}}) {
        if (closed) throw fail('expired');
        if (![20_000_000,100_000_000].includes(limit) || typeof fetchPage !== 'function') throw fail('invalid-input');
        if (jobs.size >= 8 || [...jobs.values()].filter(job=>job.owner===owner).length>=3
            || [...jobs.values()].some(job=>job.owner===owner&&job.state==='preparing')) throw fail('busy');
        const job = { owner,id:randomBytes(18).toString('hex'),controller:new AbortController(),fetch:fetchPage,
            referer,limit,source,channelId,state:'preparing',downloaded:0 };
        jobs.set(job.id,job); touch(job);
        job.work = (async()=>{
            await checkedURL(job,referer);job.controller.signal.throwIfAborted();
            job.folder = await mkdtemp(join(await folder(),'item-'));
            job.controller.signal.throwIfAborted();
            const input = join(job.folder,'input.media');
            const file = await open(input,'wx',0o600);
            let hls = /\.m3u8(?:[?#]|$)/i.test(url);
            try {
                onState('Downloading media…');
                if (hls) await playlist(job,url,file);
                else {
                    const {response,url:finalURL} = await request(job,url);
                    if (/mpegurl/i.test(response.headers.get('content-type')||'')) {
                        await response.body?.cancel(); hls=true; await playlist(job,finalURL,file);
                    } else await writeResponse(job,response,file);
                }
            } finally { await file.close(); }
            job.controller.signal.throwIfAborted();
            const header = await open(input,'r'); const bytes = Buffer.alloc(65_536);
            let headerSize;
            try { headerSize=(await header.read(bytes,0,bytes.length,0)).bytesRead; } finally { await header.close(); }
            let media = hls ? {type:'video/mp4',ext:'mp4',convert:true} : identify(bytes.subarray(0,headerSize));
            let path = input;
            if (media.convert || job.downloaded>=limit) {
                if (!media.type.startsWith('video/')&&(!media.animated||media.type==='image/webp')) throw fail('image-too-large');
                onState('Compressing media…');
                path = await compress(input,job.folder,limit,job.controller.signal,{general:true,audioInput:job.audioInput,remux:hls});
                if(path!==join(job.folder,'compressed.mp4'))throw fail('invalid-output');
                media={type:'video/mp4',ext:'mp4'};
            }
            job.controller.signal.throwIfAborted();
            const info = await stat(path);
            if (!info.isFile() || !info.size || info.size>=limit) throw fail('too-large');
            job.file = await open(path,'r'); job.size=info.size; job.type=media.type;
            job.name=`${source}-${job.id.slice(0,8)}.${media.ext}`; job.state='ready'; touch(job);
            return {id:job.id,size:job.size,type:job.type,name:job.name,source,channelId,limit};
        })();
        try { return await job.work; } catch(error) { job.work=null; await release(owner,job.id); throw error; }
        finally { job.work=null; }
    }
    async function thumbnail(url,referer,fetchPage,signal) {
        const controller=new AbortController();
        const abort=()=>controller.abort(fail('cancelled'));
        signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
        const job={controller,referer,fetch:fetchPage};
        try{
            await checkedURL(job,referer);
            const {response}=await request(job,url);
            const ctype=response.headers.get('content-type')||'';
            const isWebp=/webp/i.test(ctype)||/\.webp(?:[?#]|$)/i.test(url);
            if(!isWebp&&Number(response.headers.get('content-length'))>4*CHUNK){await response.body?.cancel();return null;}
            const parts=[];let size=0,extracted=null;
            for await(const part of response.body){
                size+=part.length;if(size>4*CHUNK)throw fail('too-large');parts.push(part);
                if(isWebp&&size>=32){extracted=extractWebpFrame(Buffer.concat(parts));if(extracted)break;}
            }
            const bytes=extracted||Buffer.concat(parts);const media=identify(bytes.subarray(0,Math.min(bytes.length,65_536)));
            if(!media.type.startsWith('image/'))return null;
            bytes.type=media.type;return bytes;
        }finally{controller.abort();signal?.removeEventListener('abort',abort);}
    }
    async function read(owner,id,offset) {
        const job=get(owner,id);
        if (job.state!=='ready'||!Number.isSafeInteger(offset)||offset<0||offset>=job.size) throw fail('invalid-read');
        const bytes=Buffer.alloc(Math.min(CHUNK,job.size-offset));
        const {bytesRead}=await job.file.read(bytes,0,bytes.length,offset);
        if (bytesRead!==bytes.length) throw fail('incomplete-output');
        return new Uint8Array(bytes);
    }
    async function release(owner,id) {
        const job=jobs.get(id); if (!job||job.owner!==owner) return;
        return job.cleanup ??= (async()=>{
            job.controller.abort(fail('cancelled')); clearTimeout(job.timer);
            await job.work?.catch(()=>{}); await job.file?.close().catch(()=>{});
            if(job.folder) await rm(job.folder,{recursive:true,force:true}).catch(()=>{});
            jobs.delete(id);
        })();
    }
    async function cancel(owner,preparingOnly=false) {
        await Promise.all([...jobs.values()].filter(job=>job.owner===owner&&(!preparingOnly||job.state==='preparing')).map(job=>release(owner,job.id)));
    }
    async function close() {
        closed=true; await Promise.all([...new Set([...jobs.values()].map(job=>job.owner))].map(owner=>cancel(owner)));
        const directory=root&&await root.catch(()=>null); if(directory) await rm(directory,{recursive:true,force:true});
    }
    return {prepare,thumbnail,read,release,cancel,close};
}
module.exports={createSourceFiles,publicURL,publicAddress,identify,CHUNK,requestReferer};
