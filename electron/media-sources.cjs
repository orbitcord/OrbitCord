const { BrowserWindow, WebContentsView, session, ipcMain, Menu, nativeImage } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomBytes } = require('node:crypto');
const {readFileSync,writeFileSync,renameSync}=require('node:fs');
const { createSourceFiles, requestReferer, publicURL } = require('./media-source-files.cjs');
const { scanMediaPage } = require('./media-source-scan.cjs');
const { sourceBlobResponse } = require('./media-source-blob.cjs');

const SOURCES = [
    {id:'gifreels',name:'GifReels',home:'https://gifreels.com/'},
    {id:'xxxtik',name:'XXXTik',home:'https://xxxtik.com/'},
];
const errors = {
    'access-denied':'This media needs a working site session or cannot be downloaded. Sign in on the site and retry.',
    'unsupported-media':'This item is not a supported image or video file. Open the original media page and refresh.',
    'protected-stream':'Encrypted or protected streams cannot be attached. Choose a downloadable file.',
    'separate-audio':'This stream uses a separate audio track and is not supported yet.',
    'unsupported-stream':'Live, discontinuous or byte-range streams cannot be attached yet.',
    'invalid-playlist':'The site returned an unsupported streaming playlist.',
    'ffmpeg-missing':'Install FFmpeg and restart Lowcord to prepare this video.',
    'invalid-url':'The site returned an unsupported media address.',
    'too-large':'This media exceeds the preparation limits. Choose a shorter or smaller item.',
    'image-too-large':'This image exceeds the attachment limit. Choose a smaller image.',
    'busy':'Finish the current item or return to its chat before preparing more.',
    'cancelled':'Media preparation cancelled.',
    'unsupported-blob':'This player does not expose a downloadable file. Open the site and try another item.',
    'unresolved-media':'No original media was found. Open the site, play the video or open its full image, then refresh.',
    'lookup-timeout':'The media host could not be reached. Check your connection and retry.',
};
function sourceAllows(source,value) {
    try {
        if(typeof value!=='string'||value.length>16_384)return false;
        const url=new URL(value), home=new URL(source.home), root=home.hostname.replace(/^www\./,'');
        return url.protocol==='https:'&&!url.username&&!url.password&&!url.port
            && (url.hostname===root||url.hostname.endsWith('.'+root));
    } catch{return false;}
}
function isAdStream(value) {
    try {
        const parsed=new URL(value);
        if(/(?:^|\.)(?:bkcdn\.net|hqmediago\.com|bongacams\.com|bgicdn\.com|adtng\.com|livemediahost\.com|exoclick\.com|juicyads\.com|tsyndicate\.com|trafficjunky\.net|vcmdiawe\.com)$/i.test(parsed.hostname))return true;
        return false;
    } catch { return true; }
}
// Pausing marks only videos that were playing, so showing the site resumes
// exactly those instead of leaving the source's own player stuck on pause.
const pauseVideos='[...document.querySelectorAll("video")].forEach(video=>{if(!video.paused){video.dataset.lowcordPaused="1";video.pause();}})';
const resumeVideos='[...document.querySelectorAll("video[data-lowcord-paused]")].forEach(video=>{delete video.dataset.lowcordPaused;void video.play().catch(()=>{});});window.dispatchEvent(new Event("scroll"))';
// A dedicated preview can be a direct file even when the original uses HLS.
const previewURL=item=>item.kind==='video'&&!item.blob&&[item.previewUrl,item.url].find(url=>typeof url==='string'&&/^https?:\/\/[^?#]+\.(?:mp4|webm)(?:[?#]|$)/i.test(url)&&!isAdStream(url));
function searchURLFor(sourceId,rawQuery) {
    const q=rawQuery.trim();if(!q)return null;
    const slug=encodeURIComponent(q.toLowerCase().replace(/^#+/,'').trim().replace(/\s+/g,'-'));
    switch(sourceId){
        case 'gifreels':return `https://gifreels.com/tag/${slug}`;
        case 'xxxtik':return `https://xxxtik.com/tag/${slug}`;
        default:return null;
    }
}
function createMediaSources({sources=SOURCES,files=createSourceFiles(),allowNavigation=sourceAllows,validateURL=publicURL,onEvent=()=>{},storageFile}={}) {
    const browsers=new Map(), hosts=new Map(), sessions=new Map(), previews=new Map(); let closed=false;
    const hostURL=pathToFileURL(join(__dirname,'media-browser.html')).href;
    const sourceFor=id=>sources.find(source=>source.id===id);
    let saved={};try{const parsed=JSON.parse(readFileSync(storageFile,'utf8'));if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))saved=parsed;}catch{}
    function savedPages(record){
        const pages=saved[`${record.account}:${record.source.id}`];
        return (Array.isArray(pages)?pages:[]).filter(page=>page&&typeof page.url==='string'&&typeof page.title==='string'&&allowNavigation(record.source,page.url)).slice(0,20);
    }
    const authURL=value=>{try{const url=new URL(value);return url.protocol==='https:'&&['accounts.google.com','appleid.apple.com'].includes(url.hostname)&&!url.username&&!url.password;}catch{return false;}};
    const emit=(record,event)=>{ if(!record.owner.isDestroyed()) onEvent(record.owner,{channelId:record.channelId,source:record.source.id,...event}); };
    const execJS=(wc,code,userGesture=false)=>wc&&!wc.isDestroyed()?(wc.mainFrame||wc).executeJavaScript(code,userGesture):Promise.resolve();
    async function loadPage(wc,url){
        const targetRoot=new URL(url).hostname.replace(/^www\./,'');
        for(let attempt=0;;attempt++){
            if(!wc||wc.isDestroyed())return;
            try{await wc.loadURL(url);return;}
            catch(err){
                if(!wc||wc.isDestroyed()||err?.errno===-3)return;
                try{const cur=new URL(wc.getURL()).hostname.replace(/^www\./,'');if(cur===targetRoot||cur.endsWith('.'+targetRoot))return;}catch{}
                if(attempt>=2)throw err;
                await new Promise(r=>setTimeout(r,350*(attempt+1)));
            }
        }
    }
    function publish(record) {
        if(record.window.isDestroyed()||record.window.webContents.isDestroyed()) return;
        const wc=record.view?.webContents;
        const state={
            sources:sources.map(({id,name})=>({id,name})),source:record.source.id,destination:record.destination,
            channelId:record.channelId,limit:record.limit,url:wc&&!wc.isDestroyed()?wc.getURL():'',canBack:wc&&!wc.isDestroyed()&&wc.navigationHistory.canGoBack(),
            canForward:wc&&!wc.isDestroyed()&&wc.navigationHistory.canGoForward(),items:record.items.map(({id,kind,label,width,height,duration,sent,preview})=>({id,kind,label,width,height,duration,sent,preview:preview?`lowcord-media://sources/${preview}/video`:null})),
            busy:record.busy,status:record.status,loading:record.loading,saved:savedPages(record),
        };
        record.window.webContents.send('lowcord:media-browser-state',state);
        emit(record,{state:'browse',...state});
    }
    async function thumbnails(record) {
        if(!record.thumbs||record.thumbs.signal.aborted)record.thumbs=new AbortController();
        const controller=record.thumbs;
        const queue=record.items.filter(item=>!item.thumb&&!item.thumbPending&&(item.poster||item.kind==='image')).slice(0,60);
        if(!queue.length)return;
        for(const item of queue)item.thumbPending=true;
        const referer=record.view?.webContents.getURL(),ses=record.session;
        await Promise.all([0,1,2].map(async()=>{
            while(queue.length&&!controller.signal.aborted){
                const item=queue.shift();
                try{
                    const bytes=await files.thumbnail(item.poster||item.url,referer,(url,init)=>ses.fetch(url,init),AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]));
                    if(!bytes||controller.signal.aborted||record.window.isDestroyed())continue;
                    const image=nativeImage.createFromBuffer(bytes);
                    if(!image.isEmpty()){
                        const size=image.getSize(),scale=Math.min(1,320/Math.max(size.width,size.height));
                        const preview=image.resize({width:Math.max(1,Math.round(size.width*scale)),height:Math.max(1,Math.round(size.height*scale))});
                        item.thumb='data:image/jpeg;base64,'+preview.toJPEG(60).toString('base64');
                    }else{
                        item.thumb=`data:${bytes.type||'image/webp'};base64,`+bytes.toString('base64');
                    }
                    if(item.thumb.length>500_000){delete item.thumb;continue;}
                    emit(record,{state:'thumbnail',id:item.id,thumb:item.thumb});
                }catch{}finally{delete item.thumbPending;} // A thumbnail failure must never disable sending the original.
            }
        }));
    }
    function layout(record) {
        if(!record.view||record.window.isDestroyed()) return;
        const [width,height]=record.window.getContentSize();
        record.view.setBounds({x:0,y:48,width:Math.max(1,width),height:Math.max(1,height-76)});
    }
    function forgetPreviews(record){for(const [key,entry]of previews)if(entry.record===record)previews.delete(key);}
    function destroyView(record) {
        clearTimeout(record.scanTimer);forgetPreviews(record);record.thumbs?.abort();record.resolveAbort?.abort();
        for(const popup of record.popups) if(!popup.isDestroyed()) popup.destroy();
        record.popups.clear();
        if(!record.view) return;
        if(!record.window.isDestroyed())record.window.contentView.removeChildView(record.view);
        if(!record.view.webContents.isDestroyed()) record.view.webContents.close();
        record.view=null;
    }
    async function pageMedia(record) {
        const wc=record.view?.webContents;if(!wc||wc.isDestroyed())return {items:[]};
        const result=await execJS(wc,`(${scanMediaPage.toString()})(${JSON.stringify(record.source.id)})`);
        if(!Array.isArray(result?.items))return {items:[]};
        // MSE/blob players expose their real MP4/HLS request at the network layer.
        // Only use it for a single player, not unrelated streams on a feed.
        if(result.unsupported===1&&!result.items.some(item=>item.kind==='video')){
            const media=record.networkMedia.filter(item=>item.page===wc.getURL()&&!isAdStream(item.url));
            const manifests=media.filter(item=>item.manifest),videos=media.filter(item=>!item.manifest&&!/\/(?:init|segment|chunk)[^/]*\.mp4(?:[?#]|$)|\.(?:m4s|cmf[va]|ts|aac)(?:[?#]|$)/i.test(item.url));
            const candidate=manifests[0]||(videos.length===1?videos[0]:null);
            if(candidate)result.items.unshift({url:candidate.url,kind:'video',label:'Video',poster:result.items.find(item=>item.poster)?.poster||null});
            else if(result.blob)result.items.unshift({url:result.blob,blob:true,kind:'video',label:'Video'});
        }
        result.items=result.items.filter(item=>item&&typeof item.url==='string'&&item.url.length<=16384&&['video','image','page'].includes(item.kind)
            &&(item.kind!=='page'||allowNavigation(record.source,item.url))).slice(0,120);
        return result;
    }
    async function scan(record) {
        const wc=record.view?.webContents,generation=++record.scanGeneration;
        if(!wc||wc.isDestroyed()||record.busy||!allowNavigation(record.source,wc.getURL()))return;
        try{
            const result=await pageMedia(record);
            if(record.window.isDestroyed()||generation!==record.scanGeneration||record.view?.webContents!==wc)return;
            const previous=new Map(record.items.map(item=>[item.url,item]));
            record.items=result.items.map(item=>{
                const existing=previous.get(item.url);
                if(existing){Object.assign(existing,item,{label:String(item.label||item.kind).slice(0,100)});return existing;}
                return {...item,id:randomBytes(12).toString('hex'),label:String(item.label||item.kind).slice(0,100)};
            });
            const kept=new Set(record.items.map(item=>item.preview).filter(Boolean));
            for(const [key,entry]of previews)if(entry.record===record&&!kept.has(key))previews.delete(key);
            for(const item of record.items){
                const url=previewURL(item);if(item.preview||!url)continue;
                item.preview=randomBytes(18).toString('hex');
                previews.set(item.preview,{record,url,page:wc.getURL()});
            }
            record.loading=false;
            if(!record.items.length&&(record.scanAttempts||0)<4){
                record.scanAttempts=(record.scanAttempts||0)+1;record.loading=true;
                clearTimeout(record.scanTimer);record.scanTimer=setTimeout(()=>void scan(record),record.scanAttempts*700);
            }
            record.status=record.loading?'Loading media…':record.items.length?'Hover to preview · Click a card to send'
                :result.unsupported?'Play the video on the site, then refresh to find its original stream.'
                :'No media found. Open the site to sign in or browse, then refresh.';
            publish(record);void thumbnails(record);void execJS(wc,record.window.isVisible()?resumeVideos:pauseVideos).catch(()=>{});
        }catch{if(!record.window.isDestroyed()){record.loading=false;record.status='The page is not ready. Open the site to finish loading or sign in, then refresh.';publish(record);}}
    }
    async function activate(record,id) {
        const source=sourceFor(id); if(!source) throw new Error('Unknown media source');
        if(record.busy) throw new Error('Cancel preparation before switching sources.');
        ++record.scanGeneration; destroyView(record); record.items=[]; record.source=source;record.loading=true;record.networkMedia=[];
        const key=`${record.account}:${id}`;
        let ses=sessions.get(key);
        if(!ses){
            ses=session.fromPartition(`persist:orbitcord-source-${record.account}-${id}`);
            ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Electron|Lowcord|Datcord|OrbitCord)\/[\w.-]+/gi,''));
            ses.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
            ses.setPermissionCheckHandler(()=>false);
            // Saving happens only through an explicit Attach selection.
            ses.on('will-download',event=>event.preventDefault());
            ses.webRequest.onHeadersReceived((details,callback)=>{
                const type=Object.entries(details.responseHeaders||{}).find(([name])=>name.toLowerCase()==='content-type')?.[1]?.join(';')||'';
                if(!isAdStream(details.url)&&((/(?:video\/(?:mp4|webm)|mpegurl)/i.test(type)||/\.(?:mp4|webm|m3u8)(?:[?#]|$)/i.test(details.url)||details.resourceType==='xhr'&&/application\/octet-stream/i.test(type)&&!/\.(?:cmf[va]|m4s|ts|aac)(?:[?#]|$)/i.test(details.url)))){
                    const candidates=[...browsers.values()].filter(record=>record.session===ses&&record.view&&!record.view.webContents.isDestroyed());
                    for(const record of candidates)if((record.view.webContents.id===(details.webContentsId||details.webContents?.id)
                        ||!details.webContentsId&&!details.webContents&&candidates.length===1&&details.initiatorOrigin===new URL(record.view.webContents.getURL()).origin)
                        &&!record.networkMedia.some(item=>item.url===details.url)){
                        record.networkMedia.push({url:details.url,page:record.view.webContents.getURL(),manifest:/mpegurl/i.test(type)||/\.m3u8(?:[?#]|$)/i.test(details.url)});if(record.networkMedia.length>16)record.networkMedia.shift();
                    }
                }
                callback({});
            });sessions.set(key,ses);
        }
        record.session=ses;
        const view=record.view=new WebContentsView({webPreferences:{session:ses,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false}});
        record.window.contentView.addChildView(view); layout(record);
        const wc=view.webContents;wc.setAudioMuted(!record.window.isVisible());
        const allowed=url=>allowNavigation(source,url)||authURL(url);
        wc.on('will-navigate',(event,url)=>{if(!allowed(url)){event.preventDefault();record.status='External navigation blocked. Use this source media and login pages.';publish(record);}});
        wc.on('will-redirect',(event,url)=>{if(!allowed(url))event.preventDefault();});
        wc.on('will-attach-webview',event=>event.preventDefault());
        wc.setWindowOpenHandler(({url})=>{
            if(allowNavigation(source,url)){void loadPage(wc,url).catch(()=>{});return {action:'deny'};}
            return authURL(url)?{action:'allow',overrideBrowserWindowOptions:{parent:record.window,webPreferences:{session:ses,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}}}:{action:'deny'};
        });
        wc.on('did-create-window',popup=>{
            record.popups.add(popup);popup.once('closed',()=>record.popups.delete(popup));
            popup.webContents.on('will-navigate',(event,url)=>{if(!allowed(url))event.preventDefault();});
            popup.webContents.on('will-redirect',(event,url)=>{if(!allowed(url))event.preventDefault();});
            popup.webContents.setWindowOpenHandler(()=>({action:'deny'}));
        });
        wc.on('did-start-navigation',details=>{if(details.isMainFrame&&!details.isSameDocument){record.networkMedia=[];if(!record.busy){++record.scanGeneration;record.thumbs?.abort();forgetPreviews(record);record.items=[];record.scanAttempts=0;record.loading=true;record.status='Loading source…';publish(record);}}});
        const loaded=()=>{if(!record.busy)void execJS(wc,'window.dispatchEvent(new Event("scroll"))').catch(()=>{});publish(record);clearTimeout(record.scanTimer);record.scanTimer=setTimeout(()=>void scan(record),350);};
        wc.on('dom-ready',loaded);wc.on('did-finish-load',loaded);wc.on('did-navigate-in-page',loaded);
        wc.on('did-fail-load',(_event,code,_desc,_url,isMainFrame)=>{if(isMainFrame&&code!==-3&&!record.items.length){record.status='The site could not load. Reload or try another source; site access checks may need to be completed manually.';publish(record);}});
        wc.on('render-process-gone',()=>{record.status='The source page stopped. Reload to reopen it.';publish(record);});
        wc.on('context-menu',(_event,params)=>{
            if(!['video','image'].includes(params.mediaType)||!/^https?:\/\//.test(params.srcURL)||!allowNavigation(source,wc.getURL()))return;
            Menu.buildFromTemplate([{label:`Send ${params.mediaType} to ${record.destination}`,enabled:!record.busy,click:()=>{
                const item={id:randomBytes(12).toString('hex'),url:params.srcURL,kind:params.mediaType,label:'Selected media'};
                record.items.push(item);void pick(record,item.id);
            }}]).popup({window:record.window});
        });
        record.status='Loading source…';publish(record);
        void loadPage(wc,source.home).catch(()=>{if(!record.window.isDestroyed()&&!record.items.length){record.loading=false;record.status='This site could not be opened. Try Reload or another source.';publish(record);}});
    }
    async function fetchHtml(record,url,referer,signal) {
        const ref=requestReferer(referer,url);
        for(let attempt=0;attempt<3;attempt++){
            try {
                const response=await record.session.fetch(url,{redirect:'follow',credentials:'include',signal,
                    headers:{Accept:'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',...(ref?{Referer:ref}:{})}});
                if(!response.ok){await response.body?.cancel();return null;}
                const type=response.headers.get('content-type')||'';
                if(!/text\/(?:html|xml)|application\/(?:xhtml|xml)/i.test(type)){await response.body?.cancel();return null;}
                const text=await response.text();
                return {html:text.slice(0,1_500_000),url:response.url||url};
            } catch {
                if(signal?.aborted)return null;
                await new Promise(r=>setTimeout(r,200*(attempt+1)));
            }
        }
        return null;
    }
    async function resolvePageMedia(record,item,signal) {
        if(item.selection)return null;
        const referer=record.view?.webContents.getURL()||record.source.home;
        const page=await fetchHtml(record,item.url,referer,signal);
        if(!page)return null;
        const {html,url:pageUrl}=page;
        const decode=v=>v.replace(/&amp;/g,'&');
        if(record.source.id==='gifreels'){
            const uid=/\/gifreels\/post\/([^/"'\s<>?#]+)/i.exec(html)?.[1]||/\/gif\/([^/"'\s<>?#]+)/i.exec(pageUrl)?.[1];
            if(uid)return {url:`https://p5rn.com/cdn/storage/production/gifreels/post/${uid}/gif.mp4`,fallbackUrl:`https://xcdn.tv/cdn/storage/production/gifreels/post/${uid}/gif.mp4`,kind:'video',referer:pageUrl};
        }
        for(const pattern of [
            /<meta[^>]+(?:property=["']og:video(?::(?:url|secure_url))?["']|name=["']twitter:player:stream["'])[^>]+content=["']([^"']+)["']/gi,
            /<(?:video|source)\b[^>]*\bsrc=["']([^"']+)["']/gi,
        ]){
            let m;
            while((m=pattern.exec(html))){
                try{
                    const resolved=new URL(decode(m[1]),pageUrl).href;
                    if(/^https?:$/.test(new URL(resolved).protocol)&&/\.(?:mp4|webm|m3u8)(?:[?#]|$)/i.test(resolved)&&!isAdStream(resolved)){
                        return {url:resolved,kind:'video',referer:pageUrl};
                    }
                }catch{}
            }
        }
        return null;
    }
    async function original(record,item) {
        if(item.kind!=='page')return item;
        if(!allowNavigation(record.source,item.url))throw Object.assign(new Error('unresolved-media'),{code:'unresolved-media'});
        record.status='Finding original media…';publish(record);
        const controller=record.resolveAbort;
        const quick=await resolvePageMedia(record,item,controller.signal);
        if(quick)return quick;
        if(item.selection){
            const selection=JSON.stringify(item.selection);
            const clicked=await execJS(record.view.webContents,`(({page,index,src})=>{if(location.href!==page)return false;const node=document.images[index];if(!node||(node.currentSrc||node.src)!==src)return false;node.click();return true;})(${selection})`,true);
            if(!clicked)throw Object.assign(new Error('unresolved-media'),{code:'unresolved-media'});
        }else await loadPage(record.view.webContents,item.url);
        const start=Date.now();let played=false;
        while(Date.now()-start<15_000){
            controller.signal.throwIfAborted();if(record.window.isDestroyed())throw new Error('cancelled');
            const result=await pageMedia(record);
            const video=result.items.find(entry=>entry.kind==='video');
            if(video&&!video.blob)return video;
            if(video?.blob){
                if(!played){played=true;await execJS(record.view.webContents,'[...document.querySelectorAll("video")].forEach(video=>{video.muted=true;void video.play().catch(()=>{});})',true);}
                // MSE assigns a blob URL before its real network request starts.
                // Wait for that request rather than immediately fetching MSE.
                if(Date.now()-start>8000)return video;
            }
            // Allow lazy players time to replace a poster with an actual source.
            if(Date.now()-start>2500&&!result.hasVideo){
                const image=result.items.filter(entry=>entry.kind==='image'&&(entry.original||entry.url===result.image||entry.width>=600&&entry.height>=400)).sort((a,b)=>b.width*b.height-a.width*a.height)[0];
                if(image&&image.width>=240&&image.height>=180)return image;
            }
            await new Promise(resolve=>setTimeout(resolve,250));
        }
        throw Object.assign(new Error('unresolved-media'),{code:'unresolved-media'});
    }
    async function pick(record,id) {
        const item=record.items.find(item=>item.id===id),wc=record.view?.webContents;
        if(!item||item.sent||record.busy||!wc||wc.isDestroyed()||!allowNavigation(record.source,wc.getURL()))return;
        record.resolveAbort=new AbortController();const operation=record.operation=(record.operation||0)+1;record.busy=true;record.activeId=id;record.status='Preparing media…';publish(record);emit(record,{state:'preparing',itemId:id});
        try{
            const media=await original(record,item);
            if(!record.window.isDestroyed()&&!record.window.isVisible())void execJS(wc,pauseVideos).catch(()=>{});
            if(operation!==record.operation||record.resolveAbort?.signal.aborted)throw Object.assign(new Error('cancelled'),{code:'cancelled'});
            const referer=media.referer||wc.getURL();
            const prepareUrl=targetUrl=>files.prepare(record.owner.id,{url:media.blob?new URL('/__lowcord_selected_blob.mp4',wc.getURL()).href:targetUrl,referer,source:record.source.id,
                channelId:record.channelId,limit:record.limit,fetch:(url,init)=>media.blob?sourceBlobResponse(wc,media.url,init.signal):record.session.fetch(url,init),
                onState:status=>{record.status=status;publish(record);}});
            let result;
            try{
                result=await prepareUrl(media.url);
            }catch(primaryError){
                const fallback=media.fallbackUrl||item.fallbackUrl;
                if(!media.blob&&fallback&&fallback!==media.url&&operation===record.operation&&!record.resolveAbort?.signal.aborted){
                    result=await prepareUrl(fallback);
                }else throw primaryError;
            }
            if(record.owner.isDestroyed()||record.window.isDestroyed()){await files.release(record.owner.id,result.id);return;}
            record.status='Uploading to Discord…';publish(record);
            emit(record,{state:'ready',itemId:id,...result});
        }catch(error){
            if(operation!==record.operation)return;record.busy=false;record.resolveAbort=null;
            const code=error.code||error.message||'unknown';
            record.status=errors[code]||(/http-\d+/.test(code)?`The media host returned ${code.replace('http-','HTTP ')}. Open the site and retry.`
                :`Could not download media (${String(code).replace(/https?:\/\/\S+/g,'media host').slice(0,100)}). Open the site and retry.`);
            console.warn('[media-sources]',record.source.id,'preparation failed:',String(code).replace(/https?:\/\/\S+/g,'media host').slice(0,100));
            console.warn('[media-sources] player candidates:',record.networkMedia.length,'manifests:',record.networkMedia.filter(item=>item.manifest).length);
            emit(record,{state:'error',itemId:id,message:record.status});publish(record);
        }
    }
    async function open(owner,account,options) {
        if(closed)throw new Error('Media browser closed');
        const {channelId,limit,destination,source=sources[0]?.id}=options??{};
        if(typeof channelId!=='string'||!/^[\w-]{1,100}$/.test(channelId)||![20_000_000,100_000_000].includes(limit)||!sourceFor(source))throw new Error('Invalid media destination');
        const existing=browsers.get(owner.id);
        if(existing&&!existing.window.isDestroyed()){
            if(existing.busy&&existing.channelId!==channelId)throw new Error(`Finish or cancel the media for ${existing.destination} first.`);
            existing.channelId=channelId;existing.limit=limit;existing.destination=String(destination||'the original chat').slice(0,100);
            publish(existing);for(const item of existing.items)if(item.thumb)emit(existing,{state:'thumbnail',id:item.id,thumb:item.thumb});return;
        }
        const window=new BrowserWindow({show:false,width:1160,height:800,minWidth:800,minHeight:520,title:'Media sources · OrbitCord',
            parent:BrowserWindow.fromWebContents(owner)||undefined,backgroundColor:'#1b1c20',autoHideMenuBar:true,
            webPreferences:{partition:`orbitcord-source-toolbar-${owner.id}`,preload:join(__dirname,'media-browser-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}});
        const record={owner,account,window,channelId,limit,destination:String(destination||'the original chat').slice(0,100),
            source:sourceFor(source),items:[],networkMedia:[],busy:false,loading:true,status:'Opening source…',scanGeneration:0,popups:new Set()};
        browsers.set(owner.id,record);hosts.set(window.webContents.id,record);
        const hostId=window.webContents.id;
        window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
        window.webContents.on('will-navigate',(event,url)=>{if(url!==hostURL)event.preventDefault();});
        window.on('resize',()=>layout(record));
        window.on('hide',()=>{record.view?.webContents.setAudioMuted(true);void execJS(record.view?.webContents,pauseVideos).catch(()=>{});});
        window.on('show',()=>{record.view?.webContents.setAudioMuted(false);void execJS(record.view?.webContents,resumeVideos).catch(()=>{});});
        window.on('closed',()=>{++record.scanGeneration;destroyView(record);hosts.delete(hostId);browsers.delete(owner.id);if(record.busy)void files.cancel(owner.id,true);});
        await window.loadURL(hostURL);await activate(record,source);
    }
    async function command(owner,action,value) {
        const record=browsers.get(owner);if(!record||record.window.isDestroyed())return {error:'Reopen Media sources.'};
        try{
            if(action==='state'){publish(record);return;}
            if(record.busy&&!['result','cancel','close','site'].includes(action))throw new Error('Finish or cancel the current send first.');
            if(action==='source')await activate(record,value);
            else if(action==='scan'){record.scanAttempts=0;await scan(record);}
            else if(action==='send'||action==='attach')void pick(record,value);
            else if(action==='open-item'){
                const item=record.items.find(item=>item.id===value);
                if(!item||item.kind!=='page'||!allowNavigation(record.source,item.url))throw new Error('Cannot open this item.');
                if(item.selection){
                    const selection=JSON.stringify(item.selection);
                    await execJS(record.view.webContents,`(({page,index,src})=>{if(location.href!==page)return false;const node=document.images[index];if(!node||(node.currentSrc||node.src)!==src)return false;node.click();return true;})(${selection})`,true);
                    clearTimeout(record.scanTimer);record.scanTimer=setTimeout(()=>void scan(record),500);
                }else void loadPage(record.view.webContents,item.url).catch(()=>{});
            }
            else if(action==='cancel'){record.operation=(record.operation||0)+1;record.resolveAbort?.abort();record.view?.webContents.stop();await files.cancel(record.owner.id);record.busy=false;record.status='Cancelled';publish(record);emit(record,{state:'cancelled'});}
            else if(action==='site'){record.view?.webContents.setAudioMuted(false);record.window.show();record.window.focus();record.view?.webContents.focus();void execJS(record.view?.webContents,resumeVideos).catch(()=>{});}
            else if(action==='picker'){await scan(record);record.view?.webContents.setAudioMuted(true);record.window.hide();const parent=BrowserWindow.fromWebContents(record.owner);if(parent&&!parent.isDestroyed()){parent.show();parent.focus();}}
            else if(action==='more'){
                await execJS(record.view.webContents,'window.scrollBy(0, Math.max(600,innerHeight*0.85))');
                clearTimeout(record.scanTimer);record.scanTimer=setTimeout(()=>void scan(record),700);
            }
            else if(action==='search'){
                if(typeof value!=='string'||!value.trim()||value.length>200)throw new Error('Enter a shorter search.');
                const currentURL=record.view?.webContents.getURL()||'';
                const direct=sourceAllows(record.source,currentURL)?searchURLFor(record.source.id,value):null;
                if(direct&&allowNavigation(record.source,direct)){
                    void loadPage(record.view.webContents,direct).catch(()=>{});
                }else{
                    const query=JSON.stringify(value);
                    const searched=await execJS(record.view.webContents,`(()=>{const input=document.querySelector('input[type="search"],input[name="q"],input[name="search"],input[name="query"]');if(!input||!input.form)return false;const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,${query});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));input.form.requestSubmit();return true;})()`);
                    if(!searched){record.status='Open the site to use its search, then return to the picker.';record.view?.webContents.setAudioMuted(false);record.window.show();record.window.focus();publish(record);}
                }
            }
            else if(action==='result'){
                if(!value||value.itemId!==record.activeId)return;
                if(value.phase==='uploading'||value.phase==='posting'){
                    record.busy=true;record.status=value.phase==='posting'?'Sending…':`Uploading ${Math.max(0,Math.min(100,Number(value.percent)||0))}%…`;
                }else{record.busy=false;const item=record.items.find(item=>item.id===value.itemId);if(item&&value.phase==='sent')item.sent=true;
                    record.status=value.phase==='sent'?`Sent to ${record.destination}`:String(value.message||'Sending failed. Click the card to retry.').slice(0,200);}
                publish(record);
            }
            else if(action==='close'){record.view?.webContents.setAudioMuted(true);record.window.hide();}
            else if(action==='logout'){
                if(record.busy)throw new Error('Cancel preparation before signing out.');
                await record.session.clearStorageData();await record.session.clearCache();await activate(record,record.source.id);
            }else if(action==='save'){
                const wc=record.view.webContents,url=wc.getURL();
                if(!allowNavigation(record.source,url)||/\/(?:login|logout|register|auth)(?:[/?]|$)|[?&](?:token|code|session|password)=/i.test(url))throw new Error('Open a media or creator page before saving it.');
                const pages=savedPages(record),exists=pages.some(page=>page.url===url);
                const next=exists?pages.filter(page=>page.url!==url):[{url,title:wc.getTitle().slice(0,100)||url},...pages].slice(0,20);
                const changed={...saved,[`${record.account}:${record.source.id}`]:next};
                if(storageFile){writeFileSync(storageFile+'.tmp',JSON.stringify(changed),{mode:0o600});renameSync(storageFile+'.tmp',storageFile);}
                saved=changed;record.status=exists?'Page removed from saved pages.':'Page saved for this source.';publish(record);
            }else if(action==='saved'){
                if(!savedPages(record).some(page=>page.url===value))throw new Error('Unknown saved page');
                void loadPage(record.view.webContents,value).catch(()=>{});
            }else if(action==='navigate'){
                if(!allowNavigation(record.source,value))throw new Error('Enter an HTTPS address on the selected source.');
                void loadPage(record.view.webContents,value).catch(()=>{});
            }else if(action==='back')record.view.webContents.navigationHistory.goBack();
            else if(action==='forward')record.view.webContents.navigationHistory.goForward();
            else if(action==='reload')record.view.webContents.reload();
            else if(action!=='state')throw new Error('Unknown media browser action');
            return {ok:true};
        }catch(error){return {error:error.message};}
    }
    ipcMain.handle('lowcord:media-browser',async(event,action,value)=>{
        const record=hosts.get(event.sender.id);
        if(!record||event.senderFrame!==event.sender.mainFrame||event.senderFrame.url!==hostURL)throw new Error('Untrusted media browser request');
        return command(record.owner.id,action,value);
    });
    // Picker previews: an unguessable per-item token streams that item's direct
    // file through its source session, with the referer the site expects.
    async function serve(request) {
        try{
            const match=/^\/([a-f0-9]{36})\/video$/.exec(new URL(request.url).pathname);
            const entry=match&&previews.get(match[1]);
            if(!entry||!['GET','HEAD'].includes(request.method)||entry.record.window.isDestroyed())return new Response(null,{status:404});
            const range=request.headers.get('range');
            if(range&&!/^bytes=\d+-\d*$/.test(range))return new Response(null,{status:416});
            await validateURL(entry.url);
            const referer=requestReferer(entry.page,entry.url);
            const response=await entry.record.session.fetch(entry.url,{redirect:'follow',credentials:'include',signal:request.signal,
                headers:{Referer:referer,Accept:'video/webm,video/mp4,video/*;q=0.9,*/*;q=0.5',...(range?{Range:range}:{})}});
            const type=response.headers.get('content-type')||'';
            if(![200,206].includes(response.status)||!/^(?:video\/(?:mp4|webm)|application\/octet-stream|binary\/octet-stream)(?:;|$)/i.test(type)){
                await response.body?.cancel();return new Response(null,{status:502});
            }
            await validateURL(response.url||entry.url);
            const headers=new Headers({'content-type':/^video\//i.test(type)?type:/\.webm(?:[?#]|$)/i.test(entry.url)?'video/webm':'video/mp4','cache-control':'private, max-age=600','access-control-allow-origin':'https://discord.com'});
            for(const name of ['content-length','content-range','accept-ranges']){const value=response.headers.get(name);if(value)headers.set(name,value);}
            if(request.method==='HEAD'){await response.body?.cancel();return new Response(null,{status:response.status,headers});}
            return new Response(response.body,{status:response.status,headers});
        }catch{return new Response(null,{status:404});}
    }
    async function cancel(owner){const record=browsers.get(owner);if(record&&!record.window.isDestroyed())record.window.destroy();await files.cancel(owner);}
    async function close(){closed=true;for(const record of browsers.values())if(!record.window.isDestroyed())record.window.destroy();await files.close();ipcMain.removeHandler('lowcord:media-browser');}
    return {open,command,cancel,close,serve,read:files.read,release:files.release};
}
module.exports={createMediaSources,SOURCES,sourceAllows};
