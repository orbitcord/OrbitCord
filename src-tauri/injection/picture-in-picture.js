// One shared control, outside React's attachment layout. Native PiP keeps the
// existing decoder, playback position and audio; no extra player or polling.
(() => {
    const { extensions, onDomChange } = window.Lowcord;
    if (!document.pictureInPictureEnabled || !HTMLVideoElement.prototype.requestPictureInPicture) return;
    const scope = '[id^="chat-messages-"], [role="dialog"]';
    const liveVideos = document.getElementsByTagName('video');
    let target, button, frame, unobserve, resizing, pending = false;
    const enabled = () => extensions.enabled('pictureInPicture');
    function eligible(video) {
        return video instanceof HTMLVideoElement && video.isConnected && !video.srcObject
            && Boolean(video.closest(scope)) && !video.closest('.lowcord-redgifs, .lowcord-media-sources, .lowcord-reddit-tile')
            && !(video.autoplay && video.loop && video.muted && !video.controls);
    }
    function hide() {
        target = undefined;
        button?.remove(); button = undefined;
        resizing?.disconnect(); resizing = undefined;
        unobserve?.(); unobserve = undefined;
        if (frame !== undefined) cancelAnimationFrame(frame);
        frame = undefined;
    }
    // The video's own frame: the video plus the same-size wrappers holding
    // Discord's controls overlay.
    function frameOf(video) {
        const box = video.getBoundingClientRect();
        let owner = video;
        for (let node = video.parentElement; node && node !== document.body; node = node.parentElement) {
            const rect = node.getBoundingClientRect();
            if (Math.abs(rect.width - box.width) > 2 || Math.abs(rect.height - box.height) > 2) break;
            owner = node;
        }
        return owner;
    }
    function uncovered(x, y, owner) {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
        const hit = document.elementsFromPoint(x, y).find(node => !button.contains(node));
        return Boolean(hit) && owner.contains(hit);
    }
    function position() {
        frame = undefined;
        if (!eligible(target) || !enabled()) { hide(); return; }
        const rect = target.getBoundingClientRect();
        const size = button.offsetWidth || 28, inset = 8;
        // Keep Discord's download/action toolbar clear in the opposite corner.
        const left = Math.round(rect.left + inset), top = Math.round(rect.top + inset);
        button.style.left = `${left}px`;
        button.style.top = `${top}px`;
        // The button lives on <body>, above everything. Show it only while its
        // corner of the video is really on screen: a video scrolled under the
        // channel header, or covered by a menu, popout or modal, hides it.
        const owner = frameOf(target);
        button.hidden = rect.width < 60 || rect.height < 45
            || !uncovered(left + 1, top + 1, owner) || !uncovered(left + size - 1, top + size - 1, owner);
        const active = document.pictureInPictureElement === target;
        const label = active ? 'Exit picture-in-picture' : 'Picture-in-picture';
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-pressed', String(active));
        button.title = `${label} (Alt+P)`;
        button.disabled = pending || target.readyState < 1 || !target.videoWidth;
    }
    function schedule() { if (target && frame === undefined) frame = requestAnimationFrame(position); }
    function show(video) {
        if (!enabled() || !eligible(video)) return;
        if (target === video) { schedule(); return; }
        hide(); target = video;
        button = extensions.ui('button', { type: 'button', className: 'lowcord-pip-button',
            onPointerdown: event => event.stopPropagation(),
            onClick: event => { event.preventDefault(); event.stopPropagation(); void toggle(target); } });
        // Lucide picture-in-picture-2 (ISC; electron/licenses/lucide.txt).
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
        for (const [name, value] of Object.entries({ fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8',
            'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(name, value);
        const path = document.createElementNS(svg.namespaceURI, 'path');
        path.setAttribute('d', 'M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4');
        const panel = document.createElementNS(svg.namespaceURI, 'rect');
        for (const [name, value] of Object.entries({ width: '10', height: '7', x: '12', y: '13', rx: '2' })) panel.setAttribute(name, value);
        svg.append(path, panel); button.append(svg); document.body.append(button);
        position();
        resizing = new ResizeObserver(schedule); resizing.observe(video);
        unobserve = onDomChange(schedule);
    }
    async function toggle(video) {
        if (pending || !enabled() || !eligible(video)) return;
        if (video.readyState < 1 || !video.videoWidth) {
            extensions.toast('Play this video first, then open picture-in-picture.', true); return;
        }
        pending = true;
        const entering = document.pictureInPictureElement !== video;
        const disabled = video.disablePictureInPicture;
        const restore = () => {
            video.removeEventListener('leavepictureinpicture', restore);
            video.disablePictureInPicture = disabled;
        };
        try {
            if (!entering) await document.exitPictureInPicture();
            else {
                // Discord sometimes opts out of exposing the browser control.
                // Keep the override until PiP closes: restoring it while PiP
                // is open makes Chromium immediately close the native window.
                video.addEventListener('leavepictureinpicture', restore, { once: true });
                video.disablePictureInPicture = false;
                await video.requestPictureInPicture();
                if (!enabled()) await document.exitPictureInPicture();
            }
        } catch {
            extensions.toast('Could not open picture-in-picture. Play the video and try again.', true);
        } finally {
            if (entering && document.pictureInPictureElement !== video) restore();
            pending = false; schedule();
        }
    }
    function underPointer(event) {
        const node = event.target;
        if (!(node instanceof Element) || button?.contains(node)) return;
        let video = null;
        if (node instanceof HTMLVideoElement) {
            if (eligible(node)) {
                const box = node.getBoundingClientRect();
                if (event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom) video = node;
            }
        } else {
            const container = node.closest(scope);
            const videos = container?.getElementsByTagName('video');
            if (videos?.length) {
                for (let i = 0; i < videos.length; i++) {
                    const candidate = videos[i];
                    if (!eligible(candidate)) continue;
                    const box = candidate.getBoundingClientRect();
                    if (event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom) {
                        video = candidate;
                        break;
                    }
                }
            }
        }
        if (video) show(video);
        else if (target && !button?.matches(':focus')) hide();
    }
    document.addEventListener('pointerover', event => { if (enabled() && (liveVideos.length || target)) underPointer(event); }, true);
    document.addEventListener('focusin', event => {
        if (!enabled() || (!liveVideos.length && !target) || button?.contains(event.target)) return;
        const node = event.target;
        const video = node instanceof HTMLVideoElement ? node : node.closest?.('[class*="videoWrapper_"], [class*="videoContainer_"]')?.querySelector('video');
        if (video) show(video); else hide();
    }, true);
    for (const type of ['play', 'loadedmetadata', 'enterpictureinpicture', 'leavepictureinpicture']) {
        document.addEventListener(type, event => {
            if (enabled() && eligible(event.target)) {
                if (type === 'play' || type === 'enterpictureinpicture') show(event.target);
                else if (event.target === target) schedule();
            }
        }, true);
    }
    document.addEventListener('keydown', event => {
        if (!enabled() || event.defaultPrevented || event.repeat || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.code !== 'KeyP'
            || event.target.closest?.('input, textarea, [contenteditable="true"], [role="textbox"]')) return;
        const video = document.pictureInPictureElement || target || [...document.querySelectorAll('video')].find(video => eligible(video) && !video.paused && !video.ended);
        if (!eligible(video)) return;
        event.preventDefault(); show(video); void toggle(video);
    });
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    window.addEventListener('blur', hide);
    window.addEventListener(extensions.changeEvent, () => {
        if (!enabled()) {
            hide();
            if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
        }
    });
})();
