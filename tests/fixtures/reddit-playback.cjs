const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Readable } = require('node:stream');

// Deterministic public-post responses. Large benchmark videos preserve the
// sample's MP4 headers and samples, padding one mdat with unreferenced bytes.
function createRedditFixture(root, { clipMiB = 0 } = {}) {
    const video = readFileSync(join(root, 'tests/fixtures/media/dash-video.mp4'));
    const audio = readFileSync(join(root, 'tests/fixtures/media/dash-audio.mp4'));
    const requests = [];
    let prefix, tail, padding = 0;
    if (clipMiB) {
        padding = Math.max(0, clipMiB * 1024 * 1024 - video.length);
        for (let offset = 0; offset + 8 < video.length;) {
            const size = video.readUInt32BE(offset);
            if (!size) throw new Error('Unsupported fixture box');
            if (video.toString('latin1', offset + 4, offset + 8) === 'mdat') {
                prefix = Buffer.from(video.subarray(0, offset + size));
                prefix.writeUInt32BE(size + padding, offset);
                tail = video.subarray(offset + size); break;
            }
            offset += size;
        }
        if (!prefix) throw new Error('Missing fixture media data');
    }
    function body() {
        if (!padding) return video;
        function* parts() {
            yield prefix;
            for (let offset = 0; offset < padding; offset += 64 * 1024) yield Buffer.alloc(Math.min(64 * 1024, padding - offset));
            yield tail;
        }
        return Readable.toWeb(Readable.from(parts(), { objectMode: false, highWaterMark: 64 * 1024 }),
            { strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength } });
    }
    async function fetchPage(value) {
        const url = String(value); requests.push(url);
        if (url.includes('/comments/')) {
            const id = /comments\/(\w+)/.exec(url)[1];
            return new Response(JSON.stringify([{ data: { children: [{ data: {
                title: 'Playback fixture', author: 'fixture', subreddit: 'fixture', permalink: `/comments/${id}/`,
                secure_media: { reddit_video: { fallback_url: `https://v.redd.it/${id}/DASH_480.mp4`, has_audio: true } }
            } }] } }]), { headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/about?')) return new Response('{}', { headers: { 'content-type': 'application/json' } });
        if (url.endsWith('DASHPlaylist.mpd')) return new Response('<BaseURL>DASH_480.mp4</BaseURL><BaseURL>DASH_AUDIO_128.mp4</BaseURL>');
        const isAudio = url.includes('AUDIO');
        return new Response(isAudio ? audio : body(), { headers: {
            'content-type': 'video/mp4', 'content-length': String(isAudio ? audio.length : video.length + padding)
        } });
    }
    return { fetchPage, requests, video, audio };
}
module.exports = { createRedditFixture };
