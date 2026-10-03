// Runs in the sandboxed preload's isolated world. Restart IPC is never exposed
// on Discord's window, and the shadow root keeps Discord's CSS out of the card.
function setupUpdateNotice(ipc) {
    let host, root, ready = false, state = null, revision = 0;
    const render = () => {
        if (!ready) return;
        if (!state) { host?.remove(); host = root = null; return; }
        if (!host) {
            host = document.createElement('div');
            host.id = 'orbitcord-update-notice';
            host.style.cssText = 'all:initial;position:fixed;top:72px;right:16px;width:min(420px,calc(100vw - 32px));z-index:10001;color-scheme:normal;';
            root = host.attachShadow({ mode: 'open' });
            root.innerHTML = `
                <style>
                    * { box-sizing: border-box; }
                    .card { position:relative; display:grid; grid-template-columns:36px minmax(0,1fr) auto;
                        font-family:var(--font-primary, "Segoe UI", sans-serif);
                        align-items:center; gap:12px; padding:20px 32px 20px 16px; border-radius:10px;
                        border:1px solid var(--border-subtle, rgba(148,155,164,.24));
                        background:var(--background-floating, #18191c); color:var(--text-normal, #f2f3f5);
                        box-shadow:0 6px 24px rgba(0,0,0,.22); font-size:14px; line-height:1.4; }
                    .icon { display:grid; place-items:center; width:36px; height:36px; border-radius:50%; background:#5865f2; color:white; }
                    svg { display:block; width:20px; height:20px; }
                    h2 { margin:0 0 4px; color:var(--header-primary, #f2f3f5); font-size:14px; font-weight:600; }
                    p { margin:0; color:var(--text-muted, #b5bac1); font-size:12px; overflow-wrap:anywhere; }
                    .actions { display:flex; align-items:center; gap:4px; }
                    button { border:0; border-radius:5px; padding:8px 10px; background:transparent;
                        color:var(--text-muted, #b5bac1); font:inherit; font-size:12px; font-weight:500; cursor:pointer; }
                    button:hover { background:var(--background-modifier-hover, rgba(148,155,164,.12)); color:var(--text-normal, #f2f3f5); }
                    button:focus-visible { outline:2px solid var(--brand-500, #5865f2); outline-offset:2px; }
                    button:disabled { opacity:.55; cursor:wait; }
                    .restart { background:#5865f2; color:white; }
                    .restart:hover { background:#4752c4; color:white; }
                    .close { position:absolute; top:4px; right:4px; padding:4px; }
                    .close svg { width:14px; height:14px; }
                    .error { grid-column:2 / -1; color:var(--text-danger, #fa777c); }
                    [hidden] { display:none; }
                    @media (max-width:600px) { .card { grid-template-columns:36px minmax(0,1fr); } .actions { grid-column:2; } }
                </style>
                <section class="card" aria-label="OrbitCord update">
                    <span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m-5-5 5 5 5-5M5 19h14"/></svg></span>
                    <div role="status" aria-live="polite" aria-atomic="true"><h2>Update ready</h2><p class="detail"></p></div>
                    <div class="actions"><button class="restart" type="button">Restart</button><button class="later" type="button" title="Install when you quit OrbitCord">Later</button></div>
                    <button class="close" type="button" aria-label="Dismiss update notice" title="Install when you quit OrbitCord"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg></button>
                    <p class="error" role="alert" hidden></p>
                </section>`;
            const action = (selector, channel) => root.querySelector(selector).addEventListener('click', event => {
                if (!event.isTrusted || state?.restarting) return;
                void ipc.invoke(channel).catch(error => {
                    if (!state) return;
                    state = { ...state, restarting:false, error:'Couldn’t update OrbitCord. Please try again.' };
                    console.error('[lowcord] Update notice:', error.message);
                    render();
                });
            });
            action('.restart', 'lowcord:update-restart');
            action('.later', 'lowcord:update-dismiss');
            action('.close', 'lowcord:update-dismiss');
            document.body.append(host);
        }
        root.querySelector('.detail').textContent = `OrbitCord ${state.version} is ready to install.`;
        root.querySelector('.restart').textContent = state.restarting ? 'Restarting…' : 'Restart';
        for (const button of root.querySelectorAll('button')) button.disabled = !!state.restarting;
        const error = root.querySelector('.error');
        error.hidden = !state.error;
        error.textContent = state.error || '';
    };
    ipc.on('lowcord:update-state', (_event, next) => { revision++; state = next; render(); });
    const initialize = async () => {
        ready = true;
        const requestedRevision = revision;
        try {
            const initial = await ipc.invoke('lowcord:update-state');
            if (revision === requestedRevision) state = initial;
            render();
        }
        catch (error) { console.error('[lowcord] Update notice:', error.message); }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once:true });
    else void initialize();
}
module.exports = { setupUpdateNotice };
