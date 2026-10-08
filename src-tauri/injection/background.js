// Tells the main process whether unloading Discord would interrupt something:
// a voice or video call, an upload, or media playing in the page.
(() => {
    if (window.self !== window.top || window.__lowcordBusy) return;
    const calls = new Set();
    const NativeConnection = window.RTCPeerConnection;
    // close() fires no state event, so closed connections are pruned on read.
    const prune = () => calls.forEach(call => { if (call.connectionState === "closed" || call.signalingState === "closed") calls.delete(call); });
    if (NativeConnection) window.RTCPeerConnection = new Proxy(NativeConnection, {
        construct(target, args, newTarget) {
            prune();
            const call = Reflect.construct(target, args, newTarget);
            calls.add(call);
            return call;
        },
    });
    let uploads = 0;
    const isUpload = body => body instanceof Blob || body instanceof FormData || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
        if (!isUpload(body)) return send.apply(this, arguments);
        uploads++;
        let done = false;
        const finish = () => { if (!done) { done = true; uploads--; } };
        this.addEventListener("loadend", finish, { once: true });
        try { return send.apply(this, arguments); } catch (error) { finish(); throw error; }
    };
    const nativeFetch = window.fetch;
    window.fetch = function (input, init) {
        if (!isUpload(init?.body)) return nativeFetch.apply(this, arguments);
        uploads++;
        let result;
        try { result = nativeFetch.apply(this, arguments); } catch (error) { uploads--; throw error; }
        return result.finally(() => uploads--);
    };
    window.__lowcordBusy = () => {
        prune();
        return calls.size > 0 || uploads > 0
            || [...document.querySelectorAll("video, audio")].some(media => !media.paused && !media.ended);
    };
})();
