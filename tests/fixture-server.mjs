// Local regression fixture only. No Discord account or network upload is used.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { createHash } from "node:crypto";

const fixturePort = Number(process.env.LOWCORD_FIXTURE_PORT || 4318);

const bundle = await build({ entryPoints: ["tests/fixtures/chat.mjs"], bundle: true, write: false, format: "iife" });
const uploadBundle = await build({entryPoints:["tests/fixtures/uploads.mjs"],bundle:true,write:false,format:"iife"});
const extensionsBundle = await build({ entryPoints: ["tests/fixtures/extensions.mjs"], bundle: true, write: false, format: "iife" });
const routes = {
    "/": ["text/html", await readFile("tests/fixtures/chat.html")],
    "/fixture.js": ["text/javascript", bundle.outputFiles[0].contents],
    "/appearance.js": ["text/javascript", await readFile("src-tauri/injection/chat-appearance.js")],
    "/appearance.css": ["text/css", await readFile("src-tauri/injection/chat-appearance.css")],
    "/uploads": ["text/html", await readFile("tests/fixtures/uploads.html")],
    "/uploads.js": ["text/javascript", uploadBundle.outputFiles[0].contents],
    "/extensions": ["text/html", await readFile("tests/fixtures/extensions.html")],
    "/social-links.js": ["text/javascript", await readFile("electron/social-links.cjs")],
    "/music-links.js": ["text/javascript", await readFile("electron/music-links.cjs")],
    "/extensions-fixture.js": ["text/javascript", extensionsBundle.outputFiles[0].contents],
    "/electron": ["text/html", await readFile("tests/fixtures/electron.html")],
    "/electron-child": ["text/html", "<!doctype html><title>Child frame</title><p>No native bridge here</p>"],
    "/source-worker": ["text/html", `<!doctype html><video controls width="320"></video><script>document.querySelector('video').src=URL.createObjectURL(new MediaSource());const worker=new Worker(URL.createObjectURL(new Blob(["fetch("+JSON.stringify(new URL('/source-gated.mp4',location.href).href)+").then(r=>r.arrayBuffer()).then(()=>postMessage('done'))"],{type:'text/javascript'})));</script>`],
    "/source-original": ["text/html", `<!doctype html><meta charset="utf-8"><video src="/source-gated.mp4" controls width="320" poster="/media/sample.png"></video>`],
    "/source-browser": ["text/html", `<!doctype html><meta charset="utf-8"><title>Neutral media source fixture</title><style>body{background:#17191e;color:white;font:16px system-ui;padding:24px}video,img{display:block;width:320px;margin:20px 0}button{padding:8px}</style><h1>Media source fixture</h1><p id="account"></p><button onclick="document.cookie='source_login=fixture; path=/; SameSite=Lax';document.getElementById('account').textContent='Signed in';document.querySelector('video').src='/source-gated.mp4'">Fixture sign in</button><a href="/source-browser?next=1">Next page</a><video src="/media/sample.mp4" controls preload="metadata"></video><a href="/source-original"><img src="/media/source-poster.png" width="320" alt="Open original fixture"></a><script>document.getElementById('account').textContent=document.cookie.includes('source_login=fixture')?'Signed in':'Signed out';</script>`],
    "/media/sample.mp4": ["video/mp4", await readFile("tests/fixtures/media/sample.mp4")],
    "/cdn/production/media/0312/fixture123/preview.mp4": ["video/mp4", await readFile("tests/fixtures/media/sample.mp4")],
    "/media/sample.m4a": ["audio/mp4", await readFile("tests/fixtures/media/sample.m4a")],
    "/media/sample.webm": ["video/webm", await readFile("tests/fixtures/media/sample.webm")],
    "/media/source-poster.png": ["image/png", await readFile("tests/fixtures/media/source-poster.png")],
    "/media/sample.png": ["image/png", await readFile("tests/fixtures/media/sample.png")],
    "/media/dash-video.mp4": ["video/mp4", await readFile("tests/fixtures/media/dash-video.mp4")],
    "/media/dash-audio.mp4": ["video/mp4", await readFile("tests/fixtures/media/dash-audio.mp4")],
    "/favicon.ico": ["image/x-icon", ""]
};
for (const file of ["discord.js", "extensions.js", "chat-capture.js", "mass-delete.js", "media-gallery.js", "redgifs.js", "redgifs.css", "background.js", "gif.js", "music-embeds.js", "social-embeds.js", "settings.js", "themes.js", "themes.css", "lowcord-ui.css"]) {
    routes[`/injection/${file}`] = [file.endsWith(".css") ? "text/css" : "text/javascript", await readFile(`src-tauri/injection/${file}`)];
}
for (const file of ['image-drop.js', 'picture-in-picture.js', 'picture-in-picture.css', 'video-compression.js', 'video-compression.css','media-sources.js','media-sources.css', 'reddit.js', 'reddit.css']) {
    routes[`/injection/${file}`] = [file.endsWith('.css') ? 'text/css' : 'text/javascript', await readFile(`src-tauri/injection/${file}`)];
}
// A stand-in Discord API that records exactly what reached the network.
const received = [];
createServer((request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${fixturePort}`);
    if (url.pathname === "/__received") {
        if (request.method === "DELETE") received.length = 0;
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify(received));
        return;
    }
    if(url.pathname==='/source-gated.mp4'){
        if(!request.headers.cookie?.includes('source_login=fixture')){response.writeHead(403,{'Content-Type':'text/html'});response.end('Sign in required');return;}
        const bytes=routes['/media/sample.mp4'][1];response.writeHead(200,{'Content-Type':'video/mp4','Content-Length':bytes.length});response.end(bytes);return;
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/error-reporting-proxy/")) {
        const parts = [];
        request.on("data", part => parts.push(part));
        request.on("end", () => {
            const body = Buffer.concat(parts);
            const type = request.headers["content-type"] ?? "";
            received.push({ method: request.method, path: url.pathname + url.search, type,
                body: type.includes("multipart") ? body.toString("latin1") : body.toString("utf8") });
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ ok: true }));
        });
        return;
    }
    if (url.pathname === "/upload" && request.method === "POST") {
        const parts=[];
        request.on("data",part=>parts.push(part));
        request.on("end",()=> {
            const data=Buffer.concat(parts);
            setTimeout(()=>{
                response.writeHead(url.searchParams.has("fail")?500:200,{"Content-Type":"application/json"});
                response.end(JSON.stringify({size:data.length,type:request.headers["content-type"],hash:createHash("sha256").update(data).digest("hex"),signature:data.subarray(0,8).toString("hex")}));
            },url.searchParams.has("slow")?1500:0);
        });
        return;
    }
    const route = routes[url.pathname];
    if (route && url.pathname.startsWith('/media/')) {
        const bytes = route[1];
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
        if (start > end || start >= bytes.length) {
            response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` });
            response.end(); return;
        }
        response.writeHead(range ? 206 : 200, { 'Content-Type': route[0], 'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) });
        response.end(bytes.subarray(start, end + 1)); return;
    }
    response.writeHead(route ? 200 : 404, { "Content-Type": route?.[0] ?? "text/plain", "Cache-Control": "no-store" });
    response.end(route?.[1] ?? "Not found");
}).listen(fixturePort, "127.0.0.1");
