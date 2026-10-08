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
    "/media/sample.mp4": ["video/mp4", await readFile("tests/fixtures/media/sample.mp4")],
    "/media/sample.m4a": ["audio/mp4", await readFile("tests/fixtures/media/sample.m4a")],
    "/media/sample.webm": ["video/webm", await readFile("tests/fixtures/media/sample.webm")],
    "/media/sample.png": ["image/png", await readFile("tests/fixtures/media/sample.png")],
    "/media/dash-video.mp4": ["video/mp4", await readFile("tests/fixtures/media/dash-video.mp4")],
    "/media/dash-audio.mp4": ["video/mp4", await readFile("tests/fixtures/media/dash-audio.mp4")],
    "/favicon.ico": ["image/x-icon", ""]
};
for (const file of ["discord.js", "extensions.js", "chat-capture.js", "gif.js", "music-embeds.js", "social-embeds.js", "settings.js", "themes.js", "themes.css", "lowcord-ui.css"]) {
    routes[`/injection/${file}`] = [file.endsWith(".css") ? "text/css" : "text/javascript", await readFile(`src-tauri/injection/${file}`)];
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
