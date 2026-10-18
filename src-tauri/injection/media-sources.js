(() => {
    const native=window.__LOWCORD_NATIVE__,extensions=window.Lowcord.extensions;
    if(!native?.mediaSources||!native.onMediaSource||!extensions)return;
    let current,job,running=false,preparing=false,alive=true,sequence=0;
    const enabled=()=>extensions.enabled('mediaSources');
    const selected=()=>window.Lowcord.store('SelectedChannelStore')?.getChannelId?.();
    const call=async(action,...args)=>{const result=await native.mediaSources(action,...args);if(result?.error)throw new Error(result.error);return result;};
    const command=(action,value)=>call('command',action,value);
    const ui=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text)node.textContent=text;return node;};
    function button(text,label,fn){const node=ui('button','',text);node.type='button';node.setAttribute('aria-label',label||text);node.title=label||text;node.onclick=fn;return node;}
    function notice(message,error=false){if(current){current.status.textContent=message;current.status.dataset.error=String(error);}if(error)extensions.toast(message,true);}
    function updateJob(){
        if(!current)return;
        const busy=preparing||running;current.cancel.hidden=!busy;current.cancel.disabled=job?.phase==='posting';current.source.disabled=busy;current.search.disabled=busy;
        if(current.back)current.back.disabled=busy||!current.state?.canBack;
        current.progress.hidden=!busy;
        current.progress.textContent=job?.phase==='posting'?'Sending…':job?.phase==='uploading'?`Uploading ${job.percent||0}%`:'Preparing media…';
        for(const item of current.items.values()){
            const own=job?.itemId===item.id,failed=own&&job.failed;
            item.button.disabled=!!item.sent||busy;
            if(item.openButton)item.openButton.disabled=busy;
            item.button.dataset.state=item.sent?'sent':failed?'failed':own&&busy?'sending':'';
            item.badge.textContent=item.sent?'Sent':failed?'Retry':own&&busy?current.progress.textContent:item.kind==='video'?'Video':item.kind==='page'?'Album / Page':'Image';
        }
    }
    function render(state){
        const picker=current;if(!picker||picker.channelId!==state.channelId)return;
        if(!picker.source.options.length)for(const source of state.sources||[])picker.source.append(new Option(source.name,source.id));
        picker.source.value=state.source;picker.state=state;
        if(picker.back)picker.back.disabled=!state.canBack||preparing||running;
        picker.destination.textContent=`Send to ${state.destination}`;picker.budget.textContent=`${state.limit/1_000_000} MB limit`;
        picker.status.textContent=state.status;picker.status.dataset.error='false';
        picker.saved.replaceChildren(new Option('Saved pages',''),...(state.saved||[]).map(page=>new Option(page.title,page.url)));
        const old=picker.items,next=new Map();
        for(const data of state.items||[]){
            let item=old.get(data.id);
            if(!item){
                const cell=ui('div','lowcord-sources-cell');
                const tile=button('',`Send ${data.label}`,()=>sendItem(item));tile.className='lowcord-sources-tile';
                const image=ui('img');image.alt='';image.loading='lazy';image.decoding='async';
                const fallback=ui('span','lowcord-sources-placeholder',data.kind==='video'?'▷':'▧');
                const badge=ui('span','lowcord-sources-badge');const caption=ui('span','lowcord-sources-caption',data.label);
                const action=ui('span','lowcord-sources-send','↑ Send');
                tile.append(fallback,image,badge,caption,action);
                cell.append(tile);
                let openButton=null;
                if(data.kind==='page'){
                    openButton=button('Open',`Open ${data.label}`,()=>void command('open-item',item.id).catch(error=>notice(error.message,true)));
                    openButton.className='lowcord-sources-open';
                    cell.append(openButton);
                }
                item={...data,cell,button:tile,openButton,image,badge,placeholder:fallback};
                image.onerror=()=>{image.hidden=true;fallback.hidden=false;};
            }
            Object.assign(item,data);if(data.thumb){item.image.src=data.thumb;item.image.hidden=false;item.placeholder.hidden=true;}else if(!item.image.getAttribute('src'))item.image.hidden=true;
            next.set(data.id,item);picker.grid.append(item.cell);
        }
        for(const [id,item]of old)if(!next.has(id))item.cell.remove();picker.items=next;
        picker.empty.hidden=next.size>0;picker.empty.textContent=state.loading?'Loading media…':'No media found yet. Open the site to sign in or browse, then refresh.';
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
        const maxW=Math.max(320,innerWidth-24),maxH=Math.max(240,innerHeight-36);
        picker.node.style.width=`${Math.min(picker.width||620,maxW)}px`;picker.node.style.height=`${Math.min(picker.height||650,maxH)}px`;
        picker.x=Math.max(12,Math.min(picker.x??innerWidth-660,innerWidth-picker.node.offsetWidth-12));
        picker.y=Math.max(12,Math.min(picker.y??innerHeight-picker.node.offsetHeight-90,innerHeight-picker.node.offsetHeight-12));
        picker.node.style.left=`${picker.x}px`;picker.node.style.top=`${picker.y}px`;
    }
    function gesture(picker,event,resize=false){
        if(event.button!==0||(!resize&&event.target.closest('input,select,button:not(.lowcord-sources-grip)')))return;
        event.preventDefault();const handle=event.currentTarget;const start={x:event.clientX,y:event.clientY,left:picker.x,top:picker.y,width:picker.node.offsetWidth,height:picker.node.offsetHeight};
        handle.setPointerCapture(event.pointerId);
        const move=next=>{if(resize){picker.width=Math.max(360,start.width+next.clientX-start.x);picker.height=Math.max(300,start.height+next.clientY-start.y);}else{picker.x=start.left+next.clientX-start.x;picker.y=start.top+next.clientY-start.y;}layout(picker);};
        const end=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);
            try{localStorage.setItem('lowcord-media-sources-layout',JSON.stringify({x:picker.x,y:picker.y,width:picker.width,height:picker.height}));}catch{}};
        handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
    }
    function close(){
        if(!current)return;const picker=current;current=null;picker.node.remove();window.removeEventListener('resize',picker.resize);window.removeEventListener('keydown',picker.key,true);
        if(!running&&!preparing){void call('close').catch(()=>{});if(job){void release(job);job=null;}}
        else void command('close').catch(()=>{});
        picker.editor?.isConnected&&picker.editor.focus({preventScroll:true});
    }
    async function open(){
        if(current){close();return;}if(!enabled())return;
        const channelId=selected(),channel=window.Lowcord.store('ChannelStore')?.getChannel?.(channelId);
        if(!channelId||!channel){extensions.toast('Open a DM or channel before browsing media.',true);return;}
        let saved={};try{saved=JSON.parse(localStorage.getItem('lowcord-media-sources-layout'))||{};}catch{}
        const picker={channelId,items:new Map(),editor:document.querySelector('[class*=channelTextArea_] [role=textbox], [class*=channelTextArea_] textarea')};for(const key of ['x','y','width','height'])if(Number.isFinite(saved[key]))picker[key]=saved[key];
        picker.node=ui('section','lowcord-media-sources');picker.node.setAttribute('role','dialog');picker.node.setAttribute('aria-label','Media sources picker');
        const header=ui('header','lowcord-sources-header');
        const grip=button('⠿','Move media picker',()=>{});grip.className='lowcord-sources-grip';
        grip.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home'].includes(event.key))return;event.preventDefault();if(event.key==='Home'){picker.x=picker.y=undefined;}else{picker.x+=event.key==='ArrowLeft'?-20:event.key==='ArrowRight'?20:0;picker.y+=event.key==='ArrowUp'?-20:event.key==='ArrowDown'?20:0;}layout(picker);};
        picker.source=ui('select');picker.source.setAttribute('aria-label','Media source');
        picker.source.onchange=()=>void command('source',picker.source.value).catch(error=>notice(error.message,true));
        const options=ui('div','lowcord-sources-options');options.hidden=true;
        picker.saved=ui('select');picker.saved.setAttribute('aria-label','Saved pages');picker.saved.onchange=()=>{if(picker.saved.value)void command('saved',picker.saved.value).catch(error=>notice(error.message,true));};
        options.append(picker.saved,button('Save page','Save current page',()=>void command('save').catch(error=>notice(error.message,true))),button('Sign out',null,()=>void command('logout').catch(error=>notice(error.message,true))));
        picker.back=button('←','Back',()=>void command('back').catch(error=>notice(error.message,true)));picker.back.disabled=true;
        header.append(grip,ui('strong','','Media'),picker.source,picker.back,button('↗','Open site for browsing or login',()=>void command('site').catch(error=>notice(error.message,true))),
            button('•••','Picker options',()=>{options.hidden=!options.hidden;}),button('×','Close media picker',close));header.onpointerdown=event=>gesture(picker,event);
        const form=ui('form','lowcord-sources-search');picker.search=ui('input');picker.search.type='search';picker.search.placeholder='Search this source';picker.search.maxLength=200;picker.search.setAttribute('aria-label','Search media');
        const search=button('Search',null,()=>{});search.type='submit';form.append(picker.search,search,button('↻','Refresh media',()=>void command('scan').catch(error=>notice(error.message,true))));
        form.onsubmit=event=>{event.preventDefault();void command('search',picker.search.value).catch(error=>notice(error.message,true));};
        form.onkeydown=event=>event.stopPropagation();
        picker.grid=ui('div','lowcord-sources-grid');picker.empty=ui('p','lowcord-sources-empty','Loading media…');
        const results=ui('div','lowcord-sources-results');results.append(picker.grid,picker.empty,button('Load more',null,()=>void command('more').catch(error=>notice(error.message,true))));
        picker.progress=ui('span','lowcord-sources-progress');picker.progress.hidden=true;
        picker.cancel=button('Cancel',null,()=>void cancel());picker.cancel.hidden=true;
        picker.status=ui('p','lowcord-sources-status','Opening source…');picker.status.setAttribute('role','status');
        picker.destination=ui('span','lowcord-sources-destination');picker.budget=ui('span','lowcord-sources-budget');
        const footer=ui('footer','lowcord-sources-footer');footer.append(picker.destination,picker.budget,picker.progress,picker.cancel);
        const resize=button('◢','Resize media picker',()=>{});resize.className='lowcord-sources-resize';resize.onpointerdown=event=>gesture(picker,event,true);
        resize.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home'].includes(event.key))return;event.preventDefault();
            if(event.key==='Home'){picker.width=620;picker.height=650;}else{picker.width=Math.max(360,picker.node.offsetWidth+(event.key==='ArrowLeft'?-20:event.key==='ArrowRight'?20:0));picker.height=Math.max(300,picker.node.offsetHeight+(event.key==='ArrowUp'?-20:event.key==='ArrowDown'?20:0));}layout(picker);};
        picker.node.append(header,form,options,results,picker.status,footer,resize);current=picker;document.body.append(picker.node);layout(picker);
        picker.resize=()=>layout(picker);window.addEventListener('resize',picker.resize);
        picker.key=event=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();close();}};window.addEventListener('keydown',picker.key,true);
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
