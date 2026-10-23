(() => {
    const native=window.__LOWCORD_NATIVE__,extensions=window.Lowcord.extensions;
    if(!native?.mediaSources||!native.onMediaSource||!extensions)return;
    let current,job,running=false,preparing=false,alive=true,sequence=0;
    const enabled=()=>extensions.enabled('mediaSources');
    const selected=()=>window.Lowcord.store('SelectedChannelStore')?.getChannelId?.();
    const call=async(action,...args)=>{const result=await native.mediaSources(action,...args);if(result?.error)throw new Error(result.error);return result;};
    const command=(action,value)=>call('command',action,value);
    const ui=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text)node.textContent=text;return node;};
    const paths={
        grip:'M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01',close:'M6 6l12 12M18 6 6 18',back:'m14 6-6 6 6 6',
        search:'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',refresh:'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 2M18 17a7 7 0 0 1-12 1l-2-2',
        external:'M14 4h6v6M20 4l-9 9M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6',more:'M5 12h.01M12 12h.01M19 12h.01',
        play:'m9 5 11 7-11 7Z',album:'M4 7h16v13H4zM7 4h10',resize:'m21 9-12 12m12-6-6 6',image:'M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4',
    };
    function icon(name,size=16){
        const node=document.createElementNS('http://www.w3.org/2000/svg','svg');
        for(const [key,value]of Object.entries({viewBox:'0 0 24 24',width:size,height:size,fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))node.setAttribute(key,value);
        const path=document.createElementNS(node.namespaceURI,'path');path.setAttribute('d',paths[name]);node.append(path);return node;
    }
    function button(text,label,fn,cls=''){const node=ui('button',cls,text);node.type='button';if(label){node.setAttribute('aria-label',label);node.title=label;}node.onclick=fn;return node;}
    const iconButton=(name,label,fn)=>{const node=button('',label,fn,'lowcord-sources-icon');node.append(icon(name));return node;};
    const clock=value=>Number.isFinite(value)&&value>0?`${Math.floor(value/60)}:${String(Math.floor(value%60)).padStart(2,'0')}`:'';
    const run=(action,value)=>void command(action,value).catch(error=>notice(error.message,true));
    function notice(message,error=false){if(current){current.status.textContent=message;current.status.dataset.error=String(error);current.status.hidden=!message;}if(error)extensions.toast(message,true);}
    function updateJob(){
        if(!current)return;
        const busy=preparing||running;current.cancel.hidden=!busy;current.cancel.disabled=job?.phase==='posting';
        for(const tab of current.tabs)tab.disabled=busy;current.search.disabled=busy;
        if(current.back)current.back.disabled=busy||!current.state?.canBack;
        current.progress.hidden=!busy;
        const label=job?.phase==='posting'?'Sending…':job?.phase==='uploading'?`Uploading ${job.percent||0}%`:'Preparing media…';
        current.progressText.textContent=label;
        current.progress.style.setProperty('--lowcord-sources-progress',job?.phase==='uploading'?String((job.percent||0)/100):job?.phase==='posting'?'1':'0');
        current.progress.dataset.phase=job?.phase||'preparing';
        for(const item of current.items.values()){
            const own=job?.itemId===item.id,failed=own&&job.failed;
            item.button.disabled=!!item.sent||busy;
            if(item.openButton)item.openButton.disabled=busy;
            item.button.dataset.state=item.sent?'sent':failed?'failed':own&&busy?'sending':'';
            item.badge.textContent=item.sent?'Sent':failed?'Retry':own&&busy?label:item.kind==='page'?'Album':'';
            item.badge.hidden=!item.badge.textContent;
        }
        if(busy)stopPreview(current);
    }
    // One shared muted video follows the hovered tile, as in the RedGIFs picker.
    function playbackTime(picker){
        const item=picker.previewing,video=picker.video;if(!item)return;
        const total=Number.isFinite(video.duration)&&video.duration>0?video.duration:item.duration;
        if(!Number.isFinite(total)||total<=0)return;
        const elapsed=Math.max(0,Math.min(total,video.currentTime||0));
        item.timer.textContent=`${clock(elapsed)||'0:00'} / ${clock(total)}`;item.timer.hidden=false;
        item.button.style.setProperty('--lowcord-sources-played',String(elapsed/total));
    }
    function releaseVideo(picker){
        clearTimeout(picker.previewTimer);clearTimeout(picker.resumeTimer);picker.pointerX=null;
        const item=picker.previewing;
        if(item){delete item.button.dataset.previewing;delete item.button.dataset.scrubbing;item.button.style.removeProperty('--lowcord-sources-played');item.timer.textContent=clock(item.duration);item.timer.hidden=!item.timer.textContent;}
        picker.previewing=null;
        const video=picker.video;video.pause();if(video.hasAttribute('src')){video.removeAttribute('src');video.load();}video.remove();
    }
    function stopPreview(picker,item){if(picker&&(!item||picker.previewing===item||picker.previewTarget===item)){picker.previewTarget=null;releaseVideo(picker);}}
    function preview(picker,item){
        if(current!==picker||document.hidden||picker.gesture||!item.preview||preparing||running||picker.previewTarget===item)return;
        stopPreview(picker);picker.previewTarget=item;
        // A brief hover intent avoids opening streams while crossing tiles.
        picker.previewTimer=setTimeout(()=>{
            if(current!==picker||picker.previewTarget!==item||!item.button.isConnected)return;
            picker.previewing=item;picker.video.src=item.preview;item.button.append(picker.video);picker.video.play().catch(()=>{});
        },140);
    }
    function scrub(picker,item,event){
        if(picker.previewing!==item||event.pointerType==='touch')return;
        if(picker.pointerX==null){picker.pointerX=event.clientX;return;}
        if(Math.abs(event.clientX-picker.pointerX)<2)return;picker.pointerX=event.clientX;
        const video=picker.video;if(!Number.isFinite(video.duration)||video.duration<=0||video.readyState<1)return;
        const box=item.button.getBoundingClientRect();if(!box.width)return;
        video.pause();item.button.dataset.scrubbing='true';
        video.currentTime=Math.min(video.duration-.01,Math.max(0,(event.clientX-box.left)/box.width*video.duration));playbackTime(picker);
        clearTimeout(picker.resumeTimer);
        picker.resumeTimer=setTimeout(()=>{if(picker.previewing!==item)return;delete item.button.dataset.scrubbing;video.play().catch(()=>{});},180);
    }
    function render(state){
        const picker=current;if(!picker||picker.channelId!==state.channelId)return;
        if(!picker.tabs.length){
            picker.tabs=(state.sources||[]).map(source=>{
                const tab=button(source.name,null,()=>{if(picker.state?.source!==source.id){stopPreview(picker);run('source',source.id);}},'lowcord-sources-tab');
                tab.setAttribute('role','tab');tab.dataset.source=source.id;
                tab.onkeydown=event=>{
                    if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();
                    const index=(picker.tabs.indexOf(tab)+(event.key==='ArrowLeft'?picker.tabs.length-1:1))%picker.tabs.length;
                    picker.tabs[index].focus();picker.tabs[index].click();
                };
                return tab;
            });
            picker.tabList.replaceChildren(...picker.tabs);
        }
        for(const tab of picker.tabs){const selected=tab.dataset.source===state.source;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;if(selected&&picker.state?.source!==state.source)tab.scrollIntoView({block:'nearest',inline:'nearest'});}
        picker.state=state;
        picker.back.disabled=!state.canBack||preparing||running;
        picker.destination.textContent=state.destination;picker.destination.title=`Media is sent to ${state.destination}`;
        picker.budget.textContent=`${state.limit/1_000_000} MB max`;
        picker.status.textContent=state.status;picker.status.dataset.error='false';picker.status.hidden=!state.status||!!state.items?.length&&!state.busy&&/^Hover to preview/.test(state.status);
        picker.saved.replaceChildren(new Option('Saved pages…',''),...(state.saved||[]).map(page=>new Option(page.title,page.url)));picker.saved.disabled=!state.saved?.length;
        const old=picker.items,next=new Map();
        for(const data of state.items||[]){
            let item=old.get(data.id);
            if(!item){
                const cell=ui('div','lowcord-sources-cell');
                const tile=button('',`Send ${data.label}`,()=>sendItem(item),'lowcord-sources-tile');
                const image=ui('img');image.alt='';image.loading='lazy';image.decoding='async';image.draggable=false;
                const fallback=ui('span','lowcord-sources-placeholder');fallback.append(icon(data.kind==='video'?'play':data.kind==='page'?'album':'image',28));
                const badge=ui('span','lowcord-sources-badge');const timer=ui('span','lowcord-sources-duration');
                const caption=ui('span','lowcord-sources-caption',data.label);
                const play=ui('span','lowcord-sources-play');play.append(icon('play',18));
                const played=ui('span','lowcord-sources-played');
                tile.append(fallback,image,badge,timer,caption,played);if(data.kind==='video')tile.append(play);
                cell.append(tile);
                let openButton=null;
                if(data.kind==='page'){
                    openButton=button('Open',`Open ${data.label}`,()=>run('open-item',item.id),'lowcord-sources-open');
                    cell.append(openButton);
                }
                item={...data,cell,button:tile,openButton,image,badge,timer,placeholder:fallback};
                tile.addEventListener('pointerenter',event=>{picker.pointerX=event.clientX;preview(picker,item);});
                tile.addEventListener('pointermove',event=>scrub(picker,item,event));
                tile.addEventListener('pointerleave',()=>stopPreview(picker,item));
                tile.addEventListener('focus',()=>preview(picker,item));tile.addEventListener('blur',()=>stopPreview(picker,item));
                image.onerror=()=>{image.hidden=true;fallback.hidden=false;};
            }
            Object.assign(item,data);
            if(!item.previewing){item.timer.textContent=clock(data.duration);item.timer.hidden=!item.timer.textContent;}
            if(data.thumb){item.image.src=data.thumb;item.image.hidden=false;item.placeholder.hidden=true;}else if(!item.image.getAttribute('src')){item.image.hidden=true;item.placeholder.hidden=false;}
            next.set(data.id,item);picker.grid.append(item.cell);
        }
        for(const [id,item]of old)if(!next.has(id)){stopPreview(picker,item);item.cell.remove();}picker.items=next;
        picker.empty.hidden=next.size>0;picker.more.hidden=!next.size;
        picker.empty.textContent=state.loading?'Loading media…':'No media found yet. Use the site button to sign in or browse, then refresh.';
        picker.empty.dataset.loading=String(!!state.loading);
        updateJob();
    }
    function capture(itemId,channelId){
        const reply=window.Lowcord.store('PendingReplyStore')?.getPendingReply?.(channelId);
        return {itemId,channelId,nonce:String((BigInt(Date.now())-1420070400000n)<<22n|BigInt(++sequence%4194304)),
            reference:reply?{channel_id:channelId,message_id:reply.message.id,...(reply.channel?.guild_id?{guild_id:reply.channel.guild_id}:{})}:undefined,
            abort:new AbortController(),phase:'preparing',failed:false};
    }
    function uploadFile(file,entry){
        return new Promise((resolve,reject)=>{
            const signal=entry.abort.signal;signal.throwIfAborted();
            const upload=new window.Lowcord.CloudUpload({file,isThumbnail:false,platform:1},entry.channelId);
            let done=false;
            const finish=error=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);if(error){try{upload.cancel?.();}catch{}reject(error);}else resolve(upload);};
            const abort=()=>finish(new Error('cancelled'));
            const timer=setTimeout(()=>finish(new Error('upload-failed')),120_000);signal.addEventListener('abort',abort,{once:true});
            upload.on('progress',(value,total)=>{
                const ratio=Number.isFinite(total)&&total>0?value/total:typeof value==='number'?value:value?.total?value.loaded/value.total:value?.progress;
                if(Number.isFinite(ratio)){entry.percent=Math.max(0,Math.min(100,Math.round(ratio<=1?ratio*100:ratio)));updateJob();void command('result',{itemId:entry.itemId,phase:'uploading',percent:entry.percent}).catch(()=>{});}
            });
            upload.on('complete',()=>finish());upload.on('error',()=>finish(new Error('upload-failed')));
            try{Promise.resolve(upload.upload()).catch(finish);}catch(error){finish(error);}
        });
    }
    async function release(entry){if(entry.asset){const id=entry.asset.id;entry.asset=null;await call('release',id).catch(()=>{});}}
    async function transmit(entry){
        if(running||!entry.asset||!alive||!enabled())return;
        running=true;preparing=false;entry.failed=false;entry.phase='preparing';updateJob();
        let posting=false;
        try{
            const asset=entry.asset,signal=entry.abort.signal;
            if(!window.Lowcord.CloudUpload||!window.Lowcord.RestAPI?.post)throw new Error('uploader-unavailable');
            if(!Number.isSafeInteger(asset.size)||asset.size<1||![20_000_000,100_000_000].includes(asset.limit)||asset.size>=asset.limit)throw new Error('invalid-file');
            const parts=[];
            for(let offset=0;offset<asset.size;offset+=1024*1024){
                signal.throwIfAborted();if(!alive||!enabled())throw new Error('cancelled');
                const chunk=await call('read',asset.id,offset);
                const bytes=ArrayBuffer.isView(chunk)?new Uint8Array(chunk.buffer,chunk.byteOffset,chunk.byteLength):chunk instanceof ArrayBuffer?new Uint8Array(chunk):null;
                if(!bytes||bytes.byteLength!==Math.min(1024*1024,asset.size-offset))throw new Error('incomplete-media');
                parts.push(new Blob([bytes]));
            }
            signal.throwIfAborted();if(!alive||!enabled())throw new Error('cancelled');
            const file=new File(parts,asset.name,{type:asset.type});parts.length=0;
            entry.phase='uploading';updateJob();await command('result',{itemId:entry.itemId,phase:'uploading',percent:0});
            const upload=await uploadFile(file,entry);signal.throwIfAborted();
            if(typeof upload.uploadedFilename!=='string'||!upload.uploadedFilename)throw new Error('upload-failed');
            posting=true;entry.phase='posting';updateJob();
            void command('result',{itemId:entry.itemId,phase:'posting'}).catch(()=>{});
            await window.Lowcord.RestAPI.post({url:`/channels/${entry.channelId}/messages`,body:{channel_id:entry.channelId,content:'',type:0,sticker_ids:[],
                nonce:entry.nonce,enforce_nonce:true,attachments:[{id:'0',filename:upload.filename||file.name,uploaded_filename:upload.uploadedFilename}],
                allowed_mentions:{parse:[],replied_user:false},...(entry.reference?{message_reference:entry.reference}:{})}});
            await command('result',{itemId:entry.itemId,phase:'sent'}).catch(()=>{});
            await release(entry);if(job===entry)job=null;
            extensions.toast('Media sent.');
        }catch(error){
            if(entry.abort.signal.aborted||!alive||!enabled()){await release(entry);if(job===entry)job=null;}
            else{
                entry.failed=true;entry.abort=new AbortController();
                const message=posting?'Could not confirm sending. Click Retry to check again without a duplicate.'
                    :error.message==='upload-failed'?'Discord upload failed. Click the card to retry.'
                    :error.message==='uploader-unavailable'?'Discord’s uploader is still loading. Retry in a moment.'
                    :error.message==='expired'?'Prepared media expired. Click the card to download it again.'
                    :`Couldn’t send media (${error.message==='incomplete-media'?'incomplete download':error.message==='invalid-file'?'invalid file':String(error.message).slice(0,100)}). Click the card to retry.`;
                if(error.message==='expired')await release(entry);
                await command('result',{itemId:entry.itemId,phase:'failed',message}).catch(()=>{});notice(message,true);
            }
        }finally{running=false;updateJob();if(!current&&!preparing)void call('close').catch(()=>{});}
    }
    async function sendItem(item){
        if(!item||item.sent||running||preparing)return;
        if(!window.Lowcord.CloudUpload||!window.Lowcord.RestAPI?.post){notice('Discord’s uploader is still loading. Try again in a moment.',true);return;}
        if(job?.itemId===item.id&&job.failed&&job.asset){void transmit(job);return;}
        const previous=job;if(previous?.asset)await release(previous);
        job=previous?.itemId===item.id?{...previous,abort:new AbortController(),failed:false}:capture(item.id,current.channelId);
        preparing=true;updateJob();
        try{await command('send',item.id);}catch(error){preparing=false;job.failed=true;notice(error.message,true);updateJob();}
    }
    async function cancel(){
        if(job?.phase==='posting')return;
        job?.abort.abort();preparing=false;
        await command('cancel').catch(()=>{});if(job)await release(job);job=null;updateJob();
    }
    const unsubscribe=native.onMediaSource(event=>{
        if(!alive)return;
        if(event.state==='browse')render(event);
        else if(event.state==='thumbnail'){
            const item=current?.items.get(event.id);if(item){item.image.src=event.thumb;item.image.hidden=false;item.placeholder.hidden=true;}
        }else if(event.state==='preparing'){
            if(!job||job.itemId!==event.itemId)job=capture(event.itemId,event.channelId);
            preparing=true;job.failed=false;updateJob();
        }else if(event.state==='ready'){
            preparing=false;
            if(!enabled()||!job||job.itemId!==event.itemId){void call('release',event.id).catch(()=>{});return;}
            job.asset=event;void transmit(job);
        }else if(event.state==='error'){
            preparing=false;if(job)job.failed=true;notice(event.message||'Couldn’t prepare media.',true);updateJob();
        }else if(event.state==='cancelled'){preparing=false;updateJob();}
    });
    function layout(picker){
        const maxW=Math.max(320,innerWidth-24),maxH=Math.max(260,innerHeight-36);
        picker.node.style.width=`${Math.min(picker.width||460,maxW)}px`;picker.node.style.height=`${Math.min(picker.height||680,maxH)}px`;
        picker.x=Math.max(12,Math.min(picker.x??innerWidth-picker.node.offsetWidth-16,innerWidth-picker.node.offsetWidth-12));
        picker.y=Math.max(12,Math.min(picker.y??innerHeight-picker.node.offsetHeight-90,innerHeight-picker.node.offsetHeight-12));
        picker.node.style.left=`${picker.x}px`;picker.node.style.top=`${picker.y}px`;
    }
    function gesture(picker,event,resize=false){
        if(event.button!==0||(!resize&&event.target.closest('input,select,button:not(.lowcord-sources-grip),[role=tab]')))return;
        event.preventDefault();const handle=event.currentTarget;const start={x:event.clientX,y:event.clientY,left:picker.x,top:picker.y,width:picker.node.offsetWidth,height:picker.node.offsetHeight};
        handle.setPointerCapture(event.pointerId);stopPreview(picker);picker.gesture=true;picker.node.dataset.gesture=resize?'resize':'move';
        const move=next=>{if(resize){picker.width=Math.max(340,start.width+next.clientX-start.x);picker.height=Math.max(320,start.height+next.clientY-start.y);}else{picker.x=start.left+next.clientX-start.x;picker.y=start.top+next.clientY-start.y;}layout(picker);};
        const end=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);picker.gesture=false;delete picker.node.dataset.gesture;
            try{localStorage.setItem('lowcord-media-sources-layout',JSON.stringify({x:picker.x,y:picker.y,width:picker.width,height:picker.height}));}catch{}};
        handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
    }
    function close(){
        if(!current)return;const picker=current;stopPreview(picker);current=null;picker.node.remove();window.removeEventListener('resize',picker.resize);window.removeEventListener('keydown',picker.key,true);document.removeEventListener('visibilitychange',picker.visibility);
        if(!running&&!preparing){void call('close').catch(()=>{});if(job){void release(job);job=null;}}
        else void command('close').catch(()=>{});
        picker.editor?.isConnected&&picker.editor.focus({preventScroll:true});
    }
    async function open(){
        if(current){close();return;}if(!enabled())return;
        const channelId=selected(),channel=window.Lowcord.store('ChannelStore')?.getChannel?.(channelId);
        if(!channelId||!channel){extensions.toast('Open a DM or channel before browsing media.',true);return;}
        let saved={};try{saved=JSON.parse(localStorage.getItem('lowcord-media-sources-layout'))||{};}catch{}
        const picker={channelId,items:new Map(),tabs:[],editor:document.querySelector('[class*=channelTextArea_] [role=textbox], [class*=channelTextArea_] textarea')};for(const key of ['x','y','width','height'])if(Number.isFinite(saved[key]))picker[key]=saved[key];
        picker.node=ui('section','lowcord-media-sources');picker.node.setAttribute('role','dialog');picker.node.setAttribute('aria-label','Media sources picker');
        const header=ui('header','lowcord-sources-titlebar');
        const grip=iconButton('grip','Move media picker',()=>{});grip.classList.add('lowcord-sources-grip');
        grip.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home'].includes(event.key))return;event.preventDefault();if(event.key==='Home'){picker.x=picker.y=undefined;}else{picker.x+=event.key==='ArrowLeft'?-20:event.key==='ArrowRight'?20:0;picker.y+=event.key==='ArrowUp'?-20:event.key==='ArrowDown'?20:0;}layout(picker);};
        const options=ui('div','lowcord-sources-options');options.hidden=true;
        const optionsButton=iconButton('more','Picker options',()=>{options.hidden=!options.hidden;optionsButton.setAttribute('aria-expanded',String(!options.hidden));});optionsButton.setAttribute('aria-expanded','false');
        picker.saved=ui('select');picker.saved.setAttribute('aria-label','Saved pages');picker.saved.onchange=()=>{if(picker.saved.value)run('saved',picker.saved.value);options.hidden=true;};
        options.append(ui('strong','','Saved pages'),picker.saved,
            button('Save or unsave this page','Save current page',()=>{run('save');options.hidden=true;},'lowcord-sources-option'),
            button('Sign out of this source',null,()=>{run('logout');options.hidden=true;},'lowcord-sources-option'),
            ui('p','','Hover a video to preview it and move sideways to scrub. Click any card to send it. Albums open with their Open button.'));
        header.append(grip,ui('h2','','Media'),
            iconButton('refresh','Refresh media',()=>run('scan')),iconButton('external','Open site for browsing or login',()=>run('site')),optionsButton,iconButton('close','Close media picker',close));
        header.onpointerdown=event=>gesture(picker,event);
        picker.tabList=ui('nav','lowcord-sources-tabs');picker.tabList.setAttribute('role','tablist');picker.tabList.setAttribute('aria-label','Media source');
        picker.tabList.addEventListener('wheel',event=>{if(Math.abs(event.deltaY)>Math.abs(event.deltaX)){picker.tabList.scrollLeft+=event.deltaY;event.preventDefault();}},{passive:false});
        const form=ui('form','lowcord-sources-search');picker.search=ui('input');picker.search.type='search';picker.search.placeholder='Search this source';picker.search.maxLength=200;picker.search.setAttribute('aria-label','Search media');
        picker.back=iconButton('back','Back',()=>{stopPreview(picker);run('back');});picker.back.disabled=true;
        const submit=iconButton('search','Search',()=>{});submit.type='submit';
        form.append(picker.back,picker.search,submit);
        form.onsubmit=event=>{event.preventDefault();if(picker.search.value.trim()){stopPreview(picker);run('search',picker.search.value);}};
        form.onkeydown=event=>event.stopPropagation();
        picker.grid=ui('div','lowcord-sources-grid');picker.empty=ui('p','lowcord-sources-empty','Loading media…');
        picker.more=button('Load more',null,()=>run('more'),'lowcord-sources-more');picker.more.hidden=true;
        const results=ui('div','lowcord-sources-results');results.append(picker.grid,picker.empty,picker.more);
        results.addEventListener('scroll',()=>stopPreview(picker),{passive:true});
        picker.video=ui('video','lowcord-sources-video');Object.assign(picker.video,{muted:true,loop:true,playsInline:true,preload:'none'});picker.video.setAttribute('aria-hidden','true');
        picker.video.addEventListener('playing',()=>{if(picker.previewing)picker.previewing.button.dataset.previewing='true';});
        for(const name of ['timeupdate','durationchange','seeked'])picker.video.addEventListener(name,()=>playbackTime(picker));
        picker.video.addEventListener('error',()=>{if(picker.previewing){const item=picker.previewing;item.preview=null;stopPreview(picker);}});
        picker.progress=ui('div','lowcord-sources-progress');picker.progress.hidden=true;picker.progressText=ui('span');
        picker.cancel=button('Cancel',null,()=>void cancel(),'lowcord-sources-cancel');picker.cancel.hidden=true;
        picker.progress.append(ui('span','lowcord-sources-bar'),picker.progressText,picker.cancel);
        picker.status=ui('p','lowcord-sources-status','Opening source…');picker.status.setAttribute('role','status');
        picker.destination=ui('strong','lowcord-sources-destination');picker.budget=ui('span','lowcord-sources-budget');
        const footer=ui('footer','lowcord-sources-footer');footer.append(ui('span','lowcord-sources-to','To'),picker.destination,picker.budget);
        const resize=iconButton('resize','Resize media picker',()=>{});resize.className='lowcord-sources-resize';resize.onpointerdown=event=>gesture(picker,event,true);
        resize.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home'].includes(event.key))return;event.preventDefault();
            if(event.key==='Home'){picker.width=460;picker.height=680;}else{picker.width=Math.max(340,picker.node.offsetWidth+(event.key==='ArrowLeft'?-20:event.key==='ArrowRight'?20:0));picker.height=Math.max(320,picker.node.offsetHeight+(event.key==='ArrowUp'?-20:event.key==='ArrowDown'?20:0));}layout(picker);};
        picker.node.append(header,picker.tabList,form,options,results,picker.status,picker.progress,footer,resize);current=picker;document.body.append(picker.node);layout(picker);
        picker.resize=()=>layout(picker);window.addEventListener('resize',picker.resize);
        picker.visibility=()=>{if(document.hidden)stopPreview(picker);};document.addEventListener('visibilitychange',picker.visibility);
        picker.key=event=>{if(event.key!=='Escape')return;event.preventDefault();event.stopImmediatePropagation();
            if(!options.hidden){options.hidden=true;optionsButton.setAttribute('aria-expanded','false');optionsButton.focus();}else close();};
        window.addEventListener('keydown',picker.key,true);
        const recipient=channel.getRecipientId?.()||channel.recipients?.[0],person=recipient&&window.Lowcord.store('UserStore')?.getUser?.(recipient);
        try{
            await call('open',{channelId,limit:channel.guild_id||channel.guildId?100_000_000:20_000_000,destination:channel.name||person?.globalName||person?.username||`Chat ${channelId.slice(-6)}`});
        }catch(error){notice(error.message||'Couldn’t open media sources.',true);}
    }
    window.addEventListener(extensions.changeEvent,()=>{if(!enabled()){job?.abort.abort();void cancel();close();}});
    window.addEventListener('pagehide',()=>{alive=false;job?.abort.abort();unsubscribe?.();void call('close').catch(()=>{});},{once:true});
    extensions.addComposerAction({id:'mediaSources',order:2,label:'Media sources',path:'M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 2v14h16V5H4Zm5 2 8 5-8 5V7Z',run:open});
    window.Lowcord.mediaSources={open,close,busy:()=>preparing||running};
})();
