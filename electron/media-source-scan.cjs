// Runs only in the isolated source view. Read public media metadata, never
// account state or arbitrary scripts. Linked thumbnails are pages, not files.
function scanMediaPage(provider) {
    const found=[],seen=new Set();let unsupported=0;
    const http=value=>{if(typeof value!=='string'||!value.trim())return null;try{const url=new URL(value,location.href);return /^https?:$/.test(url.protocol)?url.href:null;}catch{return null;}};
    const mediaFile=value=>/\.(?:png|jpe?g|gif|webp|avif|mp4|webm|m3u8)(?:[?#]|$)/i.test(value||'');
    const adMedia=value=>{
        const url=http(value);if(!url)return true;
        try{
            const parsed=new URL(url);
            if(/(?:^|\.)(?:bkcdn\.net|hqmediago\.com|bongacams\.com|bgicdn\.com|adtng\.com|livemediahost\.com|exoclick\.com|juicyads\.com|tsyndicate\.com|trafficjunky\.net|vcmdiawe\.com)$/i.test(parsed.hostname))return true;
            if(/(?:\/media\/fans\/avatar\/|\/avatars?\/|\/profile[-_]?(?:pic|img|photo)|loading-placeholder\.svg)/i.test(url))return true;
            return false;
        }catch{return true;}
    };
    const validPoster=value=>{const url=http(value);return url&&!adMedia(url)&&!/\.svg(?:[?#]|$)/i.test(url)?url:null;};
    const excluded=node=>node.closest?.('[data-ad], [data-ad-slot], [class~="advertisement"], [class~="ads"], [id^="ad-"], [id^="ad_"], .ad, [class*="advert"], [class*="banner"], header, nav, footer');
    const add=(value,kind,node={},extra={})=>{
        if(String(value).startsWith('blob:')){unsupported++;return;}
        const url=http(value);if(!url||adMedia(url)||seen.has(url)||found.length>=120)return;seen.add(url);
        let name;try{name=decodeURIComponent(new URL(url).pathname.split('/').pop());}catch{}
        const width=Math.round(Number(node.videoWidth||node.naturalWidth||node.width)||0),height=Math.round(Number(node.videoHeight||node.naturalHeight||node.height)||0);
        const nodeAlt=node.alt&&node.alt.toLowerCase()!=='poster'?node.alt:null;
        const rawLabel=extra.label||nodeAlt||node.getAttribute?.('aria-label')||node.getAttribute?.('title')||node.getAttribute?.('data-creator')||name||kind;
        // XXXTik uses HLS for the original and a separate MP4 for hover playback.
        const preview=provider==='xxxtik'&&kind==='video'&&/^(https?:\/\/[^/?#]+\/cdn\/production\/media\/\d+\/[\w-]+)\/master\.m3u8(?:[?#].*)?$/i.exec(url);
        found.push({...extra,...(preview?{previewUrl:`${preview[1]}/preview.mp4`}:{}),url,kind,label:String(rawLabel).replace(/\s+/g,' ').trim().slice(0,100)||name||kind,width,height,
            duration:Number.isFinite(node.duration)?Math.round(node.duration):null,poster:validPoster(extra.poster)});
    };

    const gifreelsMeta=new Map();
    let gifreelsHasAudio=false;
    if(provider==='gifreels'){
        const unwrap=v=>Array.isArray(v)?(v[0]===0?v[1]:v[0]===1&&Array.isArray(v[1])?v[1].map(unwrap):v.map(unwrap)):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,val])=>[k,unwrap(val)])):v;
        for(const island of [...document.querySelectorAll('astro-island[props]')].slice(0,20)){
            try{
                const props=unwrap(JSON.parse(island.getAttribute('props')||'{}'));
                const posts=Array.isArray(props?.posts)?props.posts:props?.post?[props.post]:[];
                for(const post of posts){
                    if(post&&typeof post.uid==='string'&&/^[\w-]{4,40}$/.test(post.uid)){
                        gifreelsMeta.set(post.uid,post);
                        if(post.hasAudio===true)gifreelsHasAudio=true;
                    }
                }
            }catch{}
        }
        for(const post of gifreelsMeta.values()){
            if(gifreelsHasAudio&&post.hasAudio===false)continue;
            const p5=`https://p5rn.com/cdn/storage/production/gifreels/post/${post.uid}`;
            const xc=`https://xcdn.tv/cdn/storage/production/gifreels/post/${post.uid}`;
            add(`${p5}/gif.mp4`,'video',{width:post.width,height:post.height},{label:post.title||post.uid,poster:`${p5}/poster-240.webp`,fallbackUrl:`${xc}/gif.mp4`});
        }
    }

    if(provider==='xxxtik'){
        try{
            for(const el of [...document.querySelectorAll('app-live-models-bar, app-home, app-video, .video-wrap, [class*="post"], [class*="item"]')].slice(0,300)){
                const ctx=el.__ngContext__;if(!Array.isArray(ctx))continue;
                for(const slot of ctx){
                    const items=Array.isArray(slot)?slot:[slot];
                    for(const item of items){
                        if(item&&typeof item==='object'&&typeof item.id==='number'&&typeof item.uid==='string'&&/^[\w-]{4,40}$/.test(item.uid)){
                            const base=`https://p5rn.com/cdn/production/media/0312/${item.uid}`;
                            const tags=Array.isArray(item.tags)?item.tags.map(t=>t?.name).filter(Boolean).join(' '):'';
                            add(`${base}/master.m3u8`,'video',{width:item.width,height:item.height},{label:item.description||item.title||tags||item.uid,poster:`${base}/thumbnail.webp`,fallbackUrl:`https://xcdn.tv/cdn/production/media/0312/${item.uid}/master.m3u8`});
                        }
                    }
                }
            }
        }catch{}
    }

    for(const node of [...document.querySelectorAll('video')].slice(0,300)){
        if(excluded(node))continue;
        const values=[node.currentSrc,node.getAttribute('src'),node.getAttribute('data-src'),...([...node.querySelectorAll('source')].map(n=>n.getAttribute('src')||n.getAttribute('data-src')))];
        const src=values.find(value=>{const u=http(value);return u&&!adMedia(u);});
        const parent=node.parentElement;const siblingImg=parent&&!/^(?:BODY|HTML|MAIN)$/.test(parent.tagName)&&parent.children.length<=6?parent.querySelector('img'):null;
        const poster=validPoster(node.poster||node.getAttribute('data-poster')||siblingImg?.currentSrc||siblingImg?.src);
        if(src){
            const gifreelsMatch=provider==='gifreels'&&/^(https?:\/\/[^/]+)(\/cdn\/storage\/production\/gifreels\/post\/([^/?#]+))\/gif(?:-\d+)?\.mp4(?:[?#].*)?$/i.exec(src);
            if(gifreelsMatch){
                const [,origin,pathPart,uid]=gifreelsMatch;
                if(gifreelsHasAudio&&gifreelsMeta.get(uid)?.hasAudio===false)continue;
                const primaryHost=/^https?:\/\/xcdn\.tv$/i.test(origin)?'https://p5rn.com':origin;
                const fallbackHost=/^https?:\/\/p5rn\.com$/i.test(primaryHost)?'https://xcdn.tv':'https://p5rn.com';
                const label=gifreelsMeta.get(uid)?.title||siblingImg?.alt||node.alt||uid;
                add(`${primaryHost}${pathPart}/gif.mp4`,'video',node,{label,poster:poster||`${primaryHost}${pathPart}/poster-240.webp`,fallbackUrl:`${fallbackHost}${pathPart}/gif.mp4`});
            }else{
                add(src,'video',node,{poster});
            }
        }else if(values.some(value=>String(value).startsWith('blob:')))unsupported++;
    }
    for(const meta of document.querySelectorAll('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"],meta[name="twitter:player:stream"]')){
        const value=meta.content;if(value&&(/\.(?:mp4|webm|m3u8)(?:[?#]|$)/i.test(value)))add(value,'video',{}, {poster:http(document.querySelector('meta[property="og:image"]')?.content)});
    }
    // JSON-LD contentUrl is a documented media field; do not execute player code.
    let visited=0;
    const structured=value=>{
        if(!value||typeof value!=='object'||++visited>500)return;
        if(value['@type']==='VideoObject'&&typeof value.contentUrl==='string')add(value.contentUrl,'video',{}, {poster:http(Array.isArray(value.thumbnailUrl)?value.thumbnailUrl[0]:value.thumbnailUrl)});
        for(const child of Object.values(value))if(child&&typeof child==='object')Array.isArray(child)?child.forEach(structured):structured(child);
    };
    for(const script of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0,10))if(script.textContent.length<500_000){try{structured(JSON.parse(script.textContent));}catch{}}
    const videoPosters=new Set(found.filter(item=>item.kind==='video').map(item=>item.poster).filter(Boolean));
    for(const [index,node] of [...document.querySelectorAll('img')].slice(0,2000).entries()){
        if(excluded(node))continue;
        const dataSrc=node.getAttribute('data-src');
        const original=node.getAttribute('data-original');
        const anchor=node.closest('a[href]');
        const rawHref=http(anchor?.getAttribute('href'));
        const href=rawHref&&rawHref.split('#')[0]!==location.href.split('#')[0]?rawHref.split('#')[0]:null;
        if(!original&&Math.max(node.naturalWidth,node.width)<120&&Math.max(node.naturalHeight,node.height)<100)continue;
        const thumb=http(node.currentSrc||dataSrc||node.src);
        if(!thumb||adMedia(thumb)||videoPosters.has(thumb)||/\.svg(?:[?#]|$)/i.test(thumb)||/^(?:logo|avatar|profile picture)(?:\b|$)/i.test(node.alt||''))continue;

        if(provider==='gifreels'){
            const m=/^(https?:\/\/[^/]+)(\/cdn\/storage\/production\/gifreels\/post\/([^/?#]+))\/poster(?:-\d+)?\.webp(?:[?#].*)?$/i.exec(thumb);
            if(m){
                const [,origin,pathPart,uid]=m;
                if(gifreelsHasAudio&&gifreelsMeta.get(uid)?.hasAudio===false)continue;
                const primaryHost=/^https?:\/\/xcdn\.tv$/i.test(origin)?'https://p5rn.com':origin;
                const fallbackHost=/^https?:\/\/p5rn\.com$/i.test(primaryHost)?'https://xcdn.tv':'https://p5rn.com';
                const label=gifreelsMeta.get(uid)?.title||node.alt||uid;
                add(`${primaryHost}${pathPart}/gif.mp4`,'video',node,{label,poster:`${primaryHost}${pathPart}/poster-240.webp`,fallbackUrl:`${fallbackHost}${pathPart}/gif.mp4`});
                continue;
            }
        }
        if(provider==='xxxtik'){
            const m=/^(https?:\/\/[^/]+\/cdn\/production\/media\/\d+\/[\w-]+)\/thumbnail\.(?:webp|jpe?g|png)(?:[?#].*)?$/i.exec(thumb);
            if(m){add(`${m[1]}/master.m3u8`,'video',node,{poster:thumb});continue;}
        }
        if(!href&&!original&&(node.hasAttribute('masonrylazy')||node.closest('button,[role=button],figure,[class*=masonry],[class*=thumbnail]')||getComputedStyle(node).cursor==='pointer')){
            add(location.href.split('#')[0]+'#lowcord-item-'+index,'page',node,{poster:thumb,selection:{page:location.href,index,src:node.currentSrc||node.src}});continue;
        }
        if(!href&&!original&&!dataSrc&&!node.closest('main,[role=main],article,[class*=media],[class*=image],[class*=photo],[class*=gallery]')&&!mediaFile(location.href))continue;
        const path=href&&new URL(href).pathname;
        const isProfileOrNav=path&&(/^\/(?:[a-z]{2}\/?)?$/i.test(path)||/^\/(?:[a-z]{2}\/)?(?:login|register|tags?|categories|search|users?|creators?|members?|profile\.php|explore)(?:\/|$)/i.test(path));
        const isPage=href&&!mediaFile(href)&&href!==location.href&&!isProfileOrNav;
        if(href&&!mediaFile(href)&&!isPage&&!original)continue;
        const value=original||(href&&mediaFile(href)?href:null)||(isPage?href:null)||thumb;
        const pageLabel=(node.alt&&node.alt.toLowerCase()!=='poster'?node.alt:null)||anchor?.textContent?.trim();
        if(isPage&&!original)add(value,'page',node,{poster:thumb,label:pageLabel});
        else add(value,/\.(?:mp4|webm|m3u8)(?:[?#]|$)/i.test(value)?'video':'image',node,{poster:thumb,label:pageLabel||undefined,original:!!original||!!(href&&mediaFile(href))});
    }
    return {items:found,unsupported,blob:[...document.querySelectorAll('video')].map(video=>video.currentSrc||video.src).find(value=>String(value).startsWith('blob:')),hasVideo:!!document.querySelector('video'),image:http(document.querySelector('meta[property="og:image"]')?.content)};
}
module.exports={scanMediaPage};
