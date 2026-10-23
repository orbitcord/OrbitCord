import {test,expect} from '@playwright/test';

test.beforeEach(async({page})=>{
    await page.goto('/extensions');await page.waitForFunction(()=>window.fixtureReady);
    await page.evaluate(async()=>{
        window.sourceCalls=[];window.sourceUploads=[];window.sourcePosts=[];window.selectedSourceChat='original';
        const original=Lowcord.store;
        Lowcord.store=name=>name==='SelectedChannelStore'?{getChannelId:()=>selectedSourceChat}
            :name==='ChannelStore'?{getChannel:id=>({id,name:id==='server'?'server-channel':'Fixture DM',guild_id:id==='server'?'guild':undefined})}
            :name==='PendingReplyStore'?{getPendingReply:()=>({message:{id:'reply-123'},channel:{guild_id:'reply-guild'}})}:original(name);
        Object.defineProperty(Lowcord,'CloudUpload',{value:class{
            constructor({file},channelId){this.file=file;this.channelId=channelId;this.handlers={};this.filename=file.name;this.uploadedFilename='native/'+file.name;}
            on(type,fn){this.handlers[type]=fn;}
            async upload(){sourceUploads.push({channelId:this.channelId,size:this.file.size,type:this.file.type});if(window.failSourceUpload){this.handlers.error();return;}this.handlers.progress(.5);this.handlers.complete();}
            cancel(){}
        }});
        Object.defineProperty(Lowcord,'RestAPI',{value:{post:async request=>{sourcePosts.push(request);if(window.failSourcePost)throw Error('network');return{body:{id:'sent'}};}}});
        window.sourceBytes=new Uint8Array(await(await fetch('/media/sample.png')).arrayBuffer());
        window.sourceState={channelId:'original',source:'gifreels',destination:'Fixture DM',limit:20_000_000,sources:[{id:'gifreels',name:'GifReels'},{id:'xxxtik',name:'XXXTik'}],
            saved:[],items:[{id:'item',kind:'image',label:'Fixture image',thumb:'data:image/png;base64,iVBORw0KGgo='}],status:'Click a card to send.'};
        window.__LOWCORD_NATIVE__={mediaSources:async(action,...args)=>{
            sourceCalls.push({action,args});
            if(action==='open'){Object.assign(sourceState,args[0]);sourceEvent({state:'browse',...sourceState});}
            if(action==='read')return sourceBytes.slice(args[1],args[1]+1024*1024);
            if(action==='command'){
                const[command,value]=args;
                if(command==='send'){
                    sourceEvent({state:'preparing',itemId:value,channelId:sourceState.channelId});
                    if(!window.holdSourceReady)sourceEvent({state:'ready',itemId:value,channelId:sourceState.channelId,id:'asset',name:'photo.png',type:'image/png',size:sourceBytes.length,limit:sourceState.limit});
                }
                if(command==='result'){sourceState.busy=['uploading','posting'].includes(value.phase);if(value.phase==='sent')sourceState.items[0].sent=true;sourceState.status=value.message||value.phase;sourceEvent({state:'browse',...sourceState});}
            }
        },onMediaSource:fn=>{window.sourceEvent=fn;return()=>{window.sourceEvent=null;};}};
        const editor=document.createElement('textarea');editor.setAttribute('aria-label','Source draft');editor.value='My existing draft';
        document.querySelector('.channelTextArea_test').append(editor);
        Lowcord.extensions.set('anonymiseFileNames',false);
    });
    await page.addStyleTag({url:'/injection/media-sources.css'});
    await page.addScriptTag({url:'/injection/media-sources.js'});
    await page.evaluate(()=>Lowcord.mediaSources.open());
});

test('picker source action uses destination budgets and supports a compact resizable grid',async({page})=>{
    await expect(page.getByRole('dialog',{name:'Media sources picker'})).toBeVisible();
    expect(await page.evaluate(()=>sourceCalls.find(c=>c.action==='open').args[0])).toEqual({channelId:'original',limit:20_000_000,destination:'Fixture DM'});
    await page.getByRole('button',{name:'Close media picker'}).click();
    await page.evaluate(()=>{selectedSourceChat='server';return Lowcord.mediaSources.open();});
    expect(await page.evaluate(()=>sourceCalls.filter(c=>c.action==='open').at(-1).args[0])).toEqual({channelId:'server',limit:100_000_000,destination:'server-channel'});
    await page.setViewportSize({width:600,height:650});
    await expect.poll(async()=>{const bounds=await page.getByRole('dialog',{name:'Media sources picker'}).boundingBox();return bounds.x+bounds.width<=600&&bounds.y+bounds.height<=650;}).toBe(true);
});
test('one click uploads and sends to the captured channel, preserves draft and reply, and marks Sent',async({page})=>{
    await page.getByRole('button',{name:'Send Fixture image',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>sourcePosts.length)).toBe(1);
    await expect(page.getByLabel('Source draft')).toHaveValue('My existing draft');
    expect(await page.evaluate(()=>sourceUploads)).toEqual([{channelId:'original',size:await page.evaluate(()=>sourceBytes.length),type:'image/png'}]);
    const request=await page.evaluate(()=>sourcePosts[0]);expect(request.url).toBe('/channels/original/messages');
    expect(request.body).toMatchObject({content:'',enforce_nonce:true,message_reference:{channel_id:'original',message_id:'reply-123',guild_id:'reply-guild'},allowed_mentions:{parse:[],replied_user:false},attachments:[{id:'0',filename:'photo.png',uploaded_filename:'native/photo.png'}]});
    await expect(page.getByRole('button',{name:'Send Fixture image',exact:true})).toBeDisabled();
    await expect(page.getByText('Sent',{exact:true})).toBeVisible();
    expect(await page.evaluate(()=>sourceCalls.some(c=>c.action==='release'))).toBe(true);
    expect(await page.evaluate(()=>Lowcord.mediaSources.busy())).toBe(false);
});
test('switching chats during preparation never sends to the newly selected chat',async({page})=>{
    await page.evaluate(()=>{holdSourceReady=true;});await page.getByRole('button',{name:'Send Fixture image'}).click();
    await page.evaluate(()=>{selectedSourceChat='different';sourceEvent({state:'ready',itemId:'item',channelId:'original',id:'asset',name:'photo.png',type:'image/png',size:sourceBytes.length,limit:20_000_000});});
    await expect.poll(()=>page.evaluate(()=>sourcePosts.length)).toBe(1);
    expect(await page.evaluate(()=>sourcePosts[0].url)).toBe('/channels/original/messages');
});
test('uncertain send retries reuse the nonce and prepared original without another download',async({page})=>{
    await page.evaluate(()=>{failSourcePost=true;});await page.getByRole('button',{name:'Send Fixture image'}).click();
    await expect(page.getByText('Retry',{exact:true})).toBeVisible();
    await page.evaluate(()=>{failSourcePost=false;});await page.getByRole('button',{name:'Send Fixture image'}).click();
    await expect.poll(()=>page.evaluate(()=>sourcePosts.length)).toBe(2);
    expect(await page.evaluate(()=>sourcePosts[0].body.nonce===sourcePosts[1].body.nonce)).toBe(true);
    expect(await page.evaluate(()=>sourceCalls.filter(c=>c.action==='command'&&c.args[0]==='send').length)).toBe(1);
});
test('upload errors show the failing stage and can be retried without claiming success',async({page})=>{
    await page.evaluate(()=>{failSourceUpload=true;});await page.getByRole('button',{name:'Send Fixture image'}).click();
    await expect(page.locator('.lowcord-sources-status')).toContainText('Discord upload failed');expect(await page.evaluate(()=>sourcePosts.length)).toBe(0);
    await page.evaluate(()=>{failSourceUpload=false;});await page.getByRole('button',{name:'Send Fixture image'}).click();
    await expect.poll(()=>page.evaluate(()=>sourcePosts.length)).toBe(1);
});
test('disabling during the final chunk read cancels without uploading or posting',async({page})=>{
    await page.evaluate(()=>{const original=__LOWCORD_NATIVE__.mediaSources;__LOWCORD_NATIVE__.mediaSources=(action,...args)=>action==='read'?new Promise(resolve=>{window.finishSourceRead=()=>resolve(sourceBytes);}):original(action,...args);});
    await page.getByRole('button',{name:'Send Fixture image'}).click();
    await expect.poll(()=>page.evaluate(()=>typeof finishSourceRead)).toBe('function');
    await page.evaluate(()=>{Lowcord.extensions.set('mediaSources',false);finishSourceRead();});
    await expect.poll(()=>page.evaluate(()=>Lowcord.mediaSources.busy())).toBe(false);expect(await page.evaluate(()=>sourceUploads.length)).toBe(0);expect(await page.evaluate(()=>sourcePosts.length)).toBe(0);
});
test('cancel before preparation completes releases a late result without sending',async({page})=>{
    await page.evaluate(()=>{holdSourceReady=true;});await page.getByRole('button',{name:'Send Fixture image'}).click();await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.evaluate(()=>sourceEvent({state:'ready',itemId:'item',channelId:'original',id:'asset',name:'photo.png',type:'image/png',size:sourceBytes.length,limit:20_000_000}));
    expect(await page.evaluate(()=>sourceUploads.length)).toBe(0);expect(await page.evaluate(()=>sourceCalls.some(c=>c.action==='release'))).toBe(true);
});
test('thumbnail links are original media pages and video metadata beats a preview image',async({page})=>{
    // Run the production scanner against neutral source markup.
    const{createRequire}=await import('node:module');const require=createRequire(import.meta.url);const{scanMediaPage}=require('../electron/media-source-scan.cjs');
    await page.setContent('<a href="https://gifreels.example/video/one"><img src="https://cdn.example/preview.jpg" width="320" height="200" alt="Video preview"></a><video src="blob:missing" width="320" height="200"></video><meta property="og:video" content="https://cdn.example/original.mp4"><meta property="og:image" content="https://cdn.example/preview.jpg">');
    const result=await page.evaluate(scanMediaPage,'gifreels');
    expect(result.items).toEqual([expect.objectContaining({kind:'video',url:'https://cdn.example/original.mp4',poster:'https://cdn.example/preview.jpg'})]);
    await page.locator('meta').evaluateAll(nodes=>nodes.forEach(n=>n.remove()));
    expect((await page.evaluate(scanMediaPage,'gifreels')).items[0]).toMatchObject({kind:'page',url:'https://gifreels.example/video/one',poster:'https://cdn.example/preview.jpg'});
});

test('dragging and resizing stop on pointer release and restore the saved position',async({page})=>{
    const picker=page.getByRole('dialog',{name:'Media sources picker'}),grip=page.getByRole('button',{name:'Move media picker'});
    const before=await picker.boundingBox(),handle=await grip.boundingBox();
    await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();await page.mouse.move(handle.x-80,handle.y+40);await page.mouse.up();
    const moved=await picker.boundingBox();expect(moved.x).toBeLessThan(before.x-50);
    await page.mouse.move(10,10);expect((await picker.boundingBox()).x).toBe(moved.x);
    const resize=page.getByRole('button',{name:'Resize media picker'});await resize.focus();await page.keyboard.press('ArrowLeft');
    expect((await picker.boundingBox()).width).toBeLessThan(moved.width);
    await page.getByRole('button',{name:'Close media picker'}).click();await page.evaluate(()=>Lowcord.mediaSources.open());
    expect((await picker.boundingBox()).x).toBe(moved.x);
});

test('provider scanners resolve direct videos/images and filter ads/avatars while page cards support Open and Back',async({page})=>{
    await page.evaluate(()=>{
        sourceState.canBack=false;
        sourceState.items=[{id:'album-1',kind:'page',label:'Sample Album',thumb:'data:image/png;base64,iVBORw0KGgo='}];
        sourceEvent({state:'browse',...sourceState});
    });
    const backBtn=page.getByRole('button',{name:'Back',exact:true});
    await expect(backBtn).toBeDisabled();
    const openBtn=page.getByRole('button',{name:'Open Sample Album',exact:true});
    await expect(openBtn).toBeVisible();
    await openBtn.click();
    expect(await page.evaluate(()=>sourceCalls.at(-1))).toEqual({action:'command',args:['open-item','album-1']});
    await page.evaluate(()=>{
        sourceState.canBack=true;
        sourceState.items=[{id:'vid-1',kind:'video',label:'Album Video 1',thumb:'data:image/png;base64,iVBORw0KGgo='}];
        sourceEvent({state:'browse',...sourceState});
    });
    await expect(backBtn).toBeEnabled();
    await backBtn.click();
    expect(await page.evaluate(()=>sourceCalls.at(-1))).toEqual({action:'command',args:['back',undefined]});

    const{createRequire}=await import('node:module');const require=createRequire(import.meta.url);const{scanMediaPage}=require('../electron/media-source-scan.cjs');
    await page.setContent(`
        <img src="https://media.gifreels.com/cdn/storage/production/gifreels/post/abc123/poster-240.webp" width="240" height="320" alt="Reel clip">
        <img src="https://cdn.example/cdn/production/media/0312/clip123/thumbnail.webp" width="240" height="320" alt="XXXTik clip">
        <img src="https://cdn.example/avatar/user.webp" width="240" height="240" alt="Avatar">
        <video src="https://cdn.hqmediago.com/ad.mp4" width="320" height="200"></video>
    `);
    const gifreels=await page.evaluate(scanMediaPage,'gifreels');
    expect(gifreels.items[0]).toMatchObject({kind:'video',url:'https://media.gifreels.com/cdn/storage/production/gifreels/post/abc123/gif.mp4',fallbackUrl:'https://p5rn.com/cdn/storage/production/gifreels/post/abc123/gif.mp4'});
    const xxxtik=await page.evaluate(scanMediaPage,'xxxtik');
    expect(xxxtik.items.find(i=>i.url.includes('/clip123/'))).toMatchObject({kind:'video',url:'https://cdn.example/cdn/production/media/0312/clip123/master.m3u8',previewUrl:'https://cdn.example/cdn/production/media/0312/clip123/preview.mp4'});
    for(const result of [gifreels,xxxtik])expect(result.items.some(i=>i.url.includes('hqmediago.com')||i.url.includes('/avatar/'))).toBe(false);
});


test('hovering a video card plays a muted preview in place and leaving stops it',async({page})=>{
    await page.evaluate(()=>{sourceState.items=[{id:'clip',kind:'video',label:'Fixture clip',duration:12,width:320,height:240,preview:'/media/sample.mp4',thumb:'data:image/png;base64,iVBORw0KGgo='}];sourceEvent({state:'browse',...sourceState});});
    const tile=page.getByRole('button',{name:'Send Fixture clip',exact:true});
    await expect(tile).toContainText('0:12');
    await tile.hover();
    await expect.poll(()=>tile.locator('video').evaluate(video=>!video.paused&&video.muted&&video.src.endsWith('/media/sample.mp4')).catch(()=>false)).toBe(true);
    await expect(tile).toHaveAttribute('data-previewing','true');
    await page.mouse.move(1,1);
    await expect(tile.locator('video')).toHaveCount(0);
});
