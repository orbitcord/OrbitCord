// OrbitCord Settings: a dialog of its own, opened from a "OrbitCord" section that
// is added to Discord's settings sidebar, or from the tray menu. Discord's
// settings screen is never re-rendered or patched.
function setupLowcordSettings() {
    if (window.__lowcordOpenSettings) return;
    const pages = [
        { id: "themes", title: "Themes", icon: "M12 3a9 9 0 1 0 0 18c1.5 0 2.2-1.2 1.6-2.4l-.3-.7c-.6-1.2.3-2.4 1.6-2.4H17a4 4 0 0 0 4-4c0-4.4-4-8.5-9-8.5ZM7.5 12.5a1 1 0 1 0 0-.01M9.5 8a1 1 0 1 0 0-.01M14.5 8a1 1 0 1 0 0-.01",
            component: () => window.__lowcordThemes?.SettingsPanel },
        { id: "appearance", title: "Chat Appearance", icon: "M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z",
            component: () => window.__lowcordChatAppearance?.SettingsPanel },
        { id: "icon", title: "Icon", icon: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm4 6.5a1.5 1.5 0 1 0 0 .01M21 16l-5-5L5 21",
            component: () => IconPanel },
        { id: "extensions", title: "Extensions", icon: "M10 3a2 2 0 0 1 4 0v1h3a1 1 0 0 1 1 1v3h1a2 2 0 0 1 0 4h-1v3a1 1 0 0 1-1 1h-3v1a2 2 0 0 1-4 0v-1H7a1 1 0 0 1-1-1v-3H5a2 2 0 0 1 0-4h1V5a1 1 0 0 1 1-1h3V3Z",
            component: () => ExtensionsPanel },
        { id: "background", title: "Background", icon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z",
            component: () => BackgroundPanel },
        { id: "accounts", title: "Accounts", icon: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 21v-1a6 6 0 0 1 12 0v1M16 3.5a4 4 0 0 1 0 7M22 21v-1a6 6 0 0 0-4-5.6",
            component: () => AccountsPanel },
        { id: "updates", title: "Check for updates", icon: "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1",
            component: () => UpdatesPanel },
    ];

    function UpdatesPanel() {
        const { React } = window.Lowcord;
        const h = React.createElement;
        const native = window.__LOWCORD_NATIVE__;
        const [state, setState] = React.useState({ status: "idle" });
        const request = React.useRef(0);
        const eventRevision = React.useRef(0);
        React.useEffect(() => {
            let live = true;
            const unsubscribe = native?.onUpdateStatus?.(next => {
                eventRevision.current++; if (live) setState(next);
            });
            const before = eventRevision.current;
            native?.updateStatus?.().then(next => {
                if (live && before === eventRevision.current) setState(next);
            }).catch(error => live && setState({ status: "error", error: error.message }));
            return () => { live = false; request.current++; unsubscribe?.(); };
        }, []);
        const action = async name => {
            const revision = ++request.current;
            const before = eventRevision.current;
            setState(previous => ({ ...previous, error: null,
                status: name === "checkForUpdates" ? "checking" : name === "downloadUpdate" ? "downloading" : "installing" }));
            try {
                const next = await native[name]();
                if (revision === request.current && before === eventRevision.current) setState(next);
            } catch (error) {
                if (revision === request.current) setState(previous => ({ ...previous, status: "error", error: error.message }));
            }
        };
        const busy = ["checking", "downloading", "installing"].includes(state.status);
        const formatBytes = bytes => {
            const value = Math.max(0, Number(bytes) || 0);
            return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} MB`
                : value >= 1000 ? `${(value / 1000).toFixed(1)} KB` : `${Math.round(value)} B`;
        };
        const phases = { connecting: "Connecting…", retrying: "Connection interrupted. Retrying…",
            verifying: "Verifying download…", complete: "Download complete" };
        const messages = {
            idle: "Check for OrbitCord updates.",
            checking: "Checking for updates…",
            "up-to-date": "You're up to date.",
            available: `OrbitCord ${state.version} is available.`,
            downloading: `Downloading OrbitCord ${state.version || "update"}…`,
            downloaded: `OrbitCord ${state.version} is ready to install.`,
            installing: state.installMode === "automatic" ? "Restarting to install the update…" : "Opening the installer…",
            error: "Couldn't update OrbitCord. Try again.",
        };
        return h("section", { className: "lowcord-chat-appearance lowcord-updates-page" },
            state.currentVersion ? h("p", { className: "lowcord-chat-intro" }, `Current version: ${state.currentVersion}`) : null,
            h("p", { role: "status", "aria-live": "polite" }, messages[state.status] || messages.idle),
            state.status === "downloading" && Number.isFinite(state.progress)
                ? h("progress", { max: 100, value: state.progress, "aria-label": "Update download progress" }) : null,
            Number.isFinite(state.total) && ['downloading', 'downloaded', 'error'].includes(state.status)
                ? h("p", { className: "lowcord-chat-description lowcord-download-details" },
                    `${formatBytes(state.transferred)} of ${formatBytes(state.total)} downloaded`,
                    state.status === 'downloading' ? ` · ${formatBytes(state.bytesPerSecond)}/s` : '',
                    state.status === 'downloading' && phases[state.downloadPhase] ? ` · ${phases[state.downloadPhase]}` : '') : null,
            state.error ? h("p", { role: "alert" }, state.error) : null,
            h("div", { className: "lowcord-updates-actions" },
                h("button", { type: "button", className: "lowcord-button", disabled: busy || !native?.checkForUpdates,
                    onClick: () => action("checkForUpdates") }, state.status === "checking" ? "Checking…" : "Check for updates"),
                ["available", "error"].includes(state.status) && state.version && state.installMode === "dmg"
                    ? h("button", { type: "button", className: "lowcord-button lowcord-button-primary",
                        onClick: () => action("downloadUpdate") }, "Download update") : null,
                state.status === "downloaded" ? h("button", { type: "button", className: "lowcord-button lowcord-button-primary",
                    onClick: () => action("installUpdate") }, state.installMode === "automatic" ? "Restart and install" : "Open installer") : null),
            state.installMode === "dmg" ? h("p", { className: "lowcord-chat-description" },
                "After downloading, open the installer, quit OrbitCord, and drag the new app to Applications to replace your current version.") : null,
            state.installMode === "unavailable" ? h("p", { className: "lowcord-chat-description" },
                "Install updates from the Mac or Windows version of OrbitCord.") : null);
    }

    // Each account opens in a window with its own login, so several accounts
    // can stay signed in at once.
    function AccountsPanel() {
        const { React } = window.Lowcord;
        const h = React.createElement;
        const native = window.__LOWCORD_NATIVE__;
        const [list, setList] = React.useState(null);
        const [error, setError] = React.useState("");
        React.useEffect(() => {
            let live = true;
            const unsubscribe = native?.onAccountsChanged?.(next => live && setList(next));
            native?.accounts?.().then(next => live && setList(next)).catch(failure => live && setError(failure.message));
            return () => { live = false; unsubscribe?.(); };
        }, []);
        const act = (action, id) => native.accounts(action, id).then(next => { setList(next); setError(""); },
            failure => setError(failure.message));
        return h("section", { className: "lowcord-chat-appearance" },
            h("p", { className: "lowcord-chat-intro" }, "Each account has its own window and stays signed in when you close it."),
            list ? h("div", { className: "lowcord-sleep-card" }, ...list.map((account, index) =>
                h("div", { key: account.id, className: "lowcord-sleep-row", style: index ? undefined : { borderTop: 0 } },
                    h("span", { className: "lowcord-sleep-label" }, h("strong", null, account.name),
                        h("span", { className: "lowcord-chat-description" },
                            account.current ? "This window" : account.open ? "Open in another window" : "Closed")),
                    h("span", { className: "lowcord-updates-actions", style: { margin: 0 } },
                        account.current ? null : h("button", { type: "button", className: "lowcord-button",
                            onClick: () => act("open", account.id) }, account.open ? "Show" : "Open"),
                        account.main ? null : h("button", { type: "button", className: "lowcord-button lowcord-button-danger",
                            onClick: () => act("remove", account.id) }, "Remove"))))) : null,
            h("div", { className: "lowcord-updates-actions" },
                h("button", { type: "button", className: "lowcord-button lowcord-button-primary", disabled: !native?.accounts,
                    onClick: () => act("new") }, "Add account")),
            h("p", { className: "lowcord-chat-description" }, "Add an account to open a new sign-in window. Removing an account signs it out on this computer."),
            error ? h("p", { role: "alert" }, error) : null);
    }

    // Window titles, the tray and notifications name the account logged in here.
    function reportAccount() {
        const native = window.__LOWCORD_NATIVE__;
        if (!native?.reportAccount) return;
        let reported;
        window.Lowcord.waitForStore("UserStore", store => {
            const report = () => {
                const name = store.getCurrentUser?.()?.username;
                if (typeof name !== "string" || !name || name === reported) return;
                reported = name;
                native.reportAccount(name).catch(() => { reported = undefined; });
            };
            store.addChangeListener?.(report);
            report();
        });
    }
    reportAccount();

    // Discord's Switch Accounts submenu signs this window into another
    // account. Ask first whether to open that account in a window of its own
    // instead, so both stay signed in.
    const submenuPrefix = "switch-accounts-submenu-";
    const switchTarget = event => {
        let item = event.target?.closest?.(`[role="menuitem"][id^="${submenuPrefix}"]`);
        // Keyboard activation targets the menu; the focused item is active.
        if (!item && event.type === "keydown") item = event.target?.closest?.(`#switch-accounts-submenu`)?.querySelector('[role="menuitem"][class*="focused"]');
        const userId = item?.id.slice(submenuPrefix.length);
        if (!userId || !/^\d+$/.test(userId) || userId === window.Lowcord.store("UserStore")?.getCurrentUser?.()?.id) return null;
        return { item, userId, name: item.textContent.trim() };
    };
    let switchingHere = false;
    function interceptSwitch(event) {
        if (switchingHere || !window.__LOWCORD_NATIVE__?.accounts) return;
        if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
        const target = switchTarget(event);
        if (!target) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        // The submenu closes when the pointer leaves it. Keep the menu item's
        // own action (Discord's switch) to run afterwards; the DOM click
        // handler needs a live React event and can't be replayed.
        let fiber = Object.entries(target.item).find(([key]) => key.startsWith("__reactFiber$"))?.[1];
        for (let depth = 0; fiber && depth < 8 && typeof fiber.memoizedProps?.action !== "function"; depth++) fiber = fiber.return;
        void chooseSwitch({ ...target, action: fiber?.memoizedProps?.action });
    }
    window.addEventListener("click", interceptSwitch, true);
    window.addEventListener("keydown", interceptSwitch, true);

    const element = (tag, props, ...children) => {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
            else if (key === "className") node.className = value;
            else node.setAttribute(key, value);
        }
        node.append(...children.filter(Boolean));
        return node;
    };
    function chooseSwitch({ item, name, action }) {
        if (document.querySelector(".lowcord-switch-backdrop")) return;
        const native = window.__LOWCORD_NATIVE__;
        const closeMenus = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
        const switchHere = () => {
            close();
            switchingHere = true;
            try {
                if (typeof action === "function") action();
                else if (item.isConnected) item.click();
            } catch (error) { console.error("[Lowcord] Switch account:", error); }
            finally { switchingHere = false; }
        };
        const openWindow = () => {
            close();
            closeMenus();
            native.accounts("open-named", { name }).catch(error => console.error("[Lowcord]", error));
        };
        const button = (label, className, onClick) => element("button", { type: "button", className, onClick }, label);
        const dialog = element("div", { className: "lowcord-voice", role: "dialog", "aria-modal": "true", "aria-labelledby": "lowcord-switch-title" },
            element("h2", { id: "lowcord-switch-title" }, `Switch to ${name}?`),
            element("p", { className: "lowcord-voice-status" },
                `Open a new window to keep both accounts signed in. You will need to log in to ${name} there the first time. Switching this window replaces the account shown here.`),
            element("div", { className: "lowcord-dialog-actions" },
                button("Switch this window", "lowcord-button", switchHere),
                button("Open in new window", "lowcord-button lowcord-button-primary", openWindow)));
        const backdrop = element("div", { className: "lowcord-voice-backdrop lowcord-switch-backdrop" }, dialog);
        // Discord's outside-click handlers would close its menus underneath.
        for (const type of ["pointerdown", "mousedown", "click"]) backdrop.addEventListener(type, event => {
            event.stopPropagation();
            if (type === "mousedown" && event.target === backdrop) close();
        });
        const onKey = event => { if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); close(); } };
        function close() { window.removeEventListener("keydown", onKey, true); backdrop.remove(); }
        window.addEventListener("keydown", onKey, true);
        document.body.append(backdrop);
        dialog.querySelector(".lowcord-button-primary").focus();
    }

    function BackgroundPanel() {
        const { React } = window.Lowcord;
        const h = React.createElement;
        const native = window.__LOWCORD_NATIVE__;
        const [settings, setSettings] = React.useState(null);
        const [error, setError] = React.useState("");
        React.useEffect(() => {
            let live = true;
            native?.background?.().then(value => live && setSettings(value)).catch(failure => live && setError(failure.message));
            return () => { live = false; };
        }, []);
        const change = next => {
            const before = settings;
            setSettings(next);
            native.background(next).then(saved => { setSettings(saved); setError(""); },
                failure => { setSettings(before); setError(failure.message); });
        };
        const delays = [[5, "5 min"], [15, "15 min"], [30, "30 min"], [60, "1 hour"]];
        const arrow = event => {
            const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
            if (!step) return;
            event.preventDefault();
            const next = delays[(delays.findIndex(([minutes]) => minutes === settings.minutes) + step + delays.length) % delays.length][0];
            change({ ...settings, minutes: next });
            event.currentTarget.parentElement.querySelector(`[data-minutes="${next}"]`)?.focus();
        };
        return h("section", { className: "lowcord-chat-appearance" },
            h("p", { className: "lowcord-chat-intro" }, "OrbitCord clears cached memory after the window has been hidden or minimized for 30 seconds."),
            settings ? h("div", { className: "lowcord-sleep-card" },
                h("label", { className: "lowcord-chat-toggle" },
                    h("span", null, h("strong", null, "Sleep in the background"),
                        h("span", { className: "lowcord-chat-description" },
                            "Unload Discord while the window is hidden to free memory. Reopen the window to load it again.")),
                    h("input", { type: "checkbox", role: "switch", checked: settings.sleep,
                        onChange: event => change({ ...settings, sleep: event.target.checked }) })),
                h("div", { className: "lowcord-sleep-row", "data-off": !settings.sleep },
                    h("span", { className: "lowcord-sleep-label" }, h("strong", null, "Sleep after"),
                        h("span", { className: "lowcord-chat-description" }, "How long to wait after you hide or minimize the window.")),
                    h("div", { className: "lowcord-segmented", role: "radiogroup", "aria-label": "Sleep after" },
                        ...delays.map(([minutes, label]) => h("button", { key: minutes, type: "button", role: "radio",
                            "data-minutes": minutes, "aria-checked": settings.minutes === minutes, disabled: !settings.sleep,
                            tabIndex: settings.minutes === minutes ? 0 : -1, onKeyDown: arrow,
                            onClick: () => change({ ...settings, minutes }) }, label)))),
                h("p", { className: "lowcord-sleep-note" },
                    "You will not receive notifications while Discord sleeps. Calls, uploads and media playback keep it awake.")) : null,
            error ? h("p", { role: "alert" }, error) : null);
    }

    const appIcons = [["default", "Default"], ["candy", "Candy"], ["champagne", "Champagne"], ["graphite", "Graphite"], ["midnight", "Midnight"], ["sun", "Sun"], ["ember", "Ember"], ["fjord", "Fjord"], ["marine", "Marine"], ["scarlet", "Scarlet"]];
    function IconPanel() {
        const { React } = window.Lowcord;
        const h = React.createElement;
        const native = window.__LOWCORD_NATIVE__;
        const windows = /Windows/.test(navigator.userAgent);
        const [current, setCurrent] = React.useState("default");
        const [previews, setPreviews] = React.useState({});
        const [error, setError] = React.useState("");
        const selection = React.useRef(0);
        React.useEffect(() => {
            let live = true;
            native?.appIcon?.().then(id => live && (!windows || selection.current === 0) && setCurrent(id)).catch(() => {});
            native?.appIcon?.("previews").then(map => live && setPreviews(map)).catch(() => {});
            return () => { live = false; };
        }, []);
        const choose = id => {
            const request = ++selection.current;
            const before = current;
            setCurrent(id);
            native.appIcon(id).then(() => {
                if (!windows || request === selection.current) setError("");
            }, failure => {
                if (windows && request !== selection.current) return;
                setCurrent(before); setError(failure.message);
                if (windows) native.appIcon().then(saved => request === selection.current && setCurrent(saved)).catch(() => {});
            });
        };
        const check = h("svg", { className: "lowcord-icon-check", viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": "true" },
            h("circle", { cx: 8, cy: 8, r: 8, fill: "currentColor" }),
            h("path", { d: "m4.8 8.3 2.1 2.1 4.3-4.5", fill: "none", stroke: "#fff", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" }));
        return h("section", { className: "lowcord-chat-appearance lowcord-icon-page" },
            h("p", { className: "lowcord-icon-lead" }, windows
                ? "Choose the OrbitCord icon for the window, taskbar, tray and shortcuts."
                : "Choose the OrbitCord icon for your Dock or taskbar."),
            h("div", { className: "lowcord-icon-grid", role: "radiogroup", "aria-label": "App icon" }, ...appIcons.map(([id, label]) =>
                h("button", { key: id, type: "button", role: "radio", "aria-checked": current === id, className: "lowcord-icon-option", onClick: () => choose(id) },
                    current === id ? check : null,
                    previews[id] ? h("img", { src: previews[id], alt: "", width: 72, height: 72, draggable: false }) : h("span", { className: "lowcord-icon-placeholder" }),
                    h("span", { className: "lowcord-icon-name" }, label)))),
            h("p", { className: "lowcord-icon-note" }, windows
                ? "Desktop, Start menu and pinned shortcuts use your selected icon. The .exe file keeps the default icon."
                : "The app file keeps its default icon in Finder or Explorer."),
            error ? h("p", { role: "alert" }, error) : null);
    }

    // Settings-only copy: extension behavior and defaults stay in the catalog.
    const extensionCategories = ["All", "Uploads", "Media", "Messaging", "Utilities"];
    const extensionDetails = {
        anonymiseFileNames: ["Uploads", "Attach a file to give it a random name. The file type and spoiler tag stay the same."],
        compressVideos: ["Uploads", "Attach a video, image or GIF. OrbitCord compresses oversized files before uploading.", "Install FFmpeg to compress videos and GIFs."],
        voiceMessages: ["Messaging", "Use the waveform button beside the message box to record and send a voice message.", "Allow microphone access when prompted."],
        redgifsPicker: ["Media", "Open RedGIFs beside the message box. Search or browse, then select a video to send it as an MP4 file."],
        mediaSources: ["Media", "Open Media sources beside the message box to browse GifReels or XXXTik. Select a photo or video to send it as a file."],
        redditPicker: ["Media", "Open Reddit to browse posts and send their photos or videos as files. Sign in to access your Reddit account.", "Install FFmpeg to compress large videos below 20 MB."],
        chatCapture: ["Messaging", "Click the camera button beside the message box. Select the first and last messages to capture them in one image."],
        mediaGallery: ["Media", "Open the gallery in the chat header to browse photos and videos. Select an item to jump to its message."],
        pictureInPicture: ["Media", "Hover over a chat video and use its pop-out button, or press Alt+P, to keep watching in a floating window."],
        downloadVideos: ["Media", "Right-click a linked or embedded video and choose Download video to save it.", "Some video links do not support downloads."],
        copyMediaLink: ["Media", "Right-click a photo or video and choose Copy Media Link to copy its URL."],
        massDelete: ["Utilities", "Click the trash button beside the message box. Choose a DM, channel or server to delete your messages from.", "Check where you are deleting messages before you start. You cannot restore them."],
        dmQuickReply: ["Messaging", "Hover over a DM in the sidebar to read and reply without leaving your current chat."],
        quickReply: ["Messaging", "In an empty message box, press Shift with the up or down arrow to select a message to reply to. Press Escape to cancel.", "This replaces the up-arrow shortcut for editing your last message."],
        clickReply: ["Messaging", "Click a chat bubble to start a reply to that message.", "Turn on chat bubbles in Chat Appearance."],
        fakeNitro: ["Utilities", "Use emojis and stickers from other servers, or choose a Nitro theme, without a Nitro subscription.", "This does not change your subscription or raise your upload limit."],
        cleanUrls: ["Utilities", "OrbitCord removes known tracking parameters from links you send."],
        silentTyping: ["Utilities", "Write messages without showing a typing indicator to other people."],
        noTracking: ["Utilities", "Blocks Discord analytics, crash reports and prompts to download the desktop app."],
        youtubeAdblock: ["Media", "Blocks ads in YouTube embeds and Watch Together."],
        musicEmbeds: ["Media", "Share a Spotify or Apple Music link to show a playable preview. Use Embed volume below the extension list to adjust previews and YouTube embeds."],
        socialEmbeds: ["Media", "Send a social post link to show its preview. Use Social embed providers below the extension list to choose a service, or use Auto to try another if one fails.", "Private or deleted posts may not embed."],
        socialCards: ["Media", "View a supported social post and its photos or videos together in one card."],
        redditVideoUpload: ["Uploads", "Send a Reddit video link to upload it as a file with sound."],
        instagramVideoUpload: ["Uploads", "Send an Instagram Reel or video link to upload its video as a file."],
        twitterVideoUpload: ["Uploads", "Send an X video link to upload the video as a file."],
        socialPhotoUpload: ["Uploads", "Send an Instagram, Reddit or X photo post or carousel link to upload its photos as files.", "Off by default. Turn it on with the card switch."],
    };

    function ExtensionsPanel() {
        const { React } = window.Lowcord;
        const h = React.createElement;
        const extensions = window.Lowcord.extensions;
        const [state, setState] = React.useState(() => extensions.state);
        const [options, setOptions] = React.useState(() => extensions.options);
        const [error, setError] = React.useState("");
        const [query, setQuery] = React.useState("");
        const [category, setCategory] = React.useState("All");
        const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        const filtered = extensions.catalog.filter(({ id, title, description }) => {
            if (category !== "All" && (extensionDetails[id]?.[0] ?? "Utilities") !== category) return false;
            const text = `${title} ${description}`.toLocaleLowerCase();
            return terms.every(term => text.includes(term));
        });
        React.useEffect(() => {
            const update = () => { setState(extensions.state); setOptions(extensions.options); };
            window.addEventListener(extensions.changeEvent, update);
            return () => window.removeEventListener(extensions.changeEvent, update);
        }, []);
        const option = (id, value) => {
            try { extensions.setOption(id, value); setError(""); } catch (failure) { setError(failure.message); }
        };
        const providerControl = (site, label) => h("label", { className: "lowcord-position-control", key: site },
            h("span", null, label),
            h("select", { value: options[`${site}Provider`], onChange: event => option(`${site}Provider`, event.target.value) },
                h("option", { value: "auto" }, "Auto · checked fallback"),
                ...window.Lowcord.socialLinks.providers[site].map(host => h("option", { key: host, value: host }, host))));
        return h("section", { className: "lowcord-chat-appearance lowcord-extensions-page" },
            h("p", { className: "lowcord-chat-intro" }, "Choose which extensions to use. Changes apply immediately."),
            h("input", { type: "search", className: "lowcord-extension-search", placeholder: "Search extensions…",
                "aria-label": "Search extensions", value: query, onChange: event => { setQuery(event.target.value); setCategory("All"); } }),
            h("div", { className: "lowcord-extension-tabs", role: "tablist", "aria-label": "Extension categories" },
                ...extensionCategories.map((name, index) => h("button", {
                    key: name, type: "button", role: "tab", id: `lowcord-extension-tab-${name}`,
                    "aria-selected": category === name, "aria-controls": "lowcord-extension-results", tabIndex: category === name ? 0 : -1,
                    onClick: () => setCategory(name),
                    onKeyDown: event => {
                        let next;
                        if (event.key === "ArrowRight") next = (index + 1) % extensionCategories.length;
                        if (event.key === "ArrowLeft") next = (index + extensionCategories.length - 1) % extensionCategories.length;
                        if (event.key === "Home") next = 0;
                        if (event.key === "End") next = extensionCategories.length - 1;
                        if (next === undefined) return;
                        event.preventDefault(); setCategory(extensionCategories[next]);
                        event.currentTarget.parentElement.children[next].focus();
                    },
                }, name))),
            h("div", { id: "lowcord-extension-results", role: "tabpanel", "aria-labelledby": `lowcord-extension-tab-${category}` },
                filtered.length === 0 ? h("p", { className: "lowcord-chat-description", role: "status" }, "No extensions found. Try a different search or category.") : null,
                h("div", { className: "lowcord-extension-list" }, ...filtered.map(({ id, title, description }) => {
                    const [group, usage, requirement] = extensionDetails[id] ?? ["Utilities", description];
                    const detailsId = `lowcord-extension-details-${id}`;
                    return h(React.Fragment, { key: id },
                        h("div", { className: "lowcord-extension-card lowcord-chat-toggle", style: { anchorName: `--lowcord-extension-${id}` } },
                            h("button", { type: "button", className: "lowcord-extension-info", "aria-label": `About ${title}`,
                                "aria-haspopup": "dialog", popoverTarget: detailsId },
                                h("strong", null, title), h("span", { className: "lowcord-chat-description" }, description)),
                            h("input", { type: "checkbox", role: "switch", "aria-label": title, checked: state[id], onChange: event => {
                                try { extensions.set(id, event.target.checked); setError(""); } catch (failure) { setError(failure.message); }
                            } })),
                        h("div", { id: detailsId, popover: "auto", role: "dialog", "aria-labelledby": `${detailsId}-title`, className: "lowcord-extension-details",
                            style: { positionAnchor: `--lowcord-extension-${id}` } },
                            h("div", { className: "lowcord-extension-details-heading" },
                                h("span", { className: "lowcord-extension-category" }, group),
                                h("button", { type: "button", className: "lowcord-settings-close", "aria-label": "Close extension details",
                                    popoverTarget: detailsId, popoverTargetAction: "hide" }, "×")),
                            h("h2", { id: `${detailsId}-title` }, title),
                            h("p", { className: "lowcord-extension-summary" }, description),
                            h("h3", null, "How it works"), h("p", null, usage),
                            requirement ? h(React.Fragment, null, h("h3", null, "Good to know"), h("p", null, requirement)) : null));
                }))),
            filtered.some(({ id }) => id === "musicEmbeds") ? h("label", { className: "lowcord-volume-card" },
                h("span", { className: "lowcord-volume-text" }, h("strong", null, "Embed volume"),
                    h("span", { className: "lowcord-chat-description" }, "YouTube, Spotify and Apple Music. Defaults to 50%.")),
                h("span", { className: "lowcord-volume-control" },
                    h("input", { type: "range", min: 0, max: 100, step: 1, value: options.musicVolume,
                        style: { "--lowcord-fill": `${options.musicVolume}%` },
                        "aria-label": "Embed volume", onChange: event => option("musicVolume", Number(event.target.value)) }),
                    h("output", null, `${options.musicVolume}%`))) : null,
            state.socialEmbeds && filtered.some(({ id }) => id === "socialEmbeds") ? h("div", { className: "lowcord-embed-options" },
                h("strong", { className: "lowcord-embed-heading" }, "Social embed providers"),
                ...Object.entries(window.Lowcord.socialLinks.sites).filter(([, site]) => site.providers.length > 1)
                    .map(([id, site]) => providerControl(id, `${id === "twitter" ? "X / Twitter" : site.name} provider`)),
                h("p", { className: "lowcord-chat-description" }, "Auto checks public post links with embed services before sending. Private or deleted posts may not embed. A chosen provider is used directly.")) : null,
            error ? h("p", { role: "alert" }, error) : null);
    }

    const icon = path => {
        const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        node.setAttribute("viewBox", "0 0 24 24"); node.setAttribute("width", "20"); node.setAttribute("height", "20");
        node.setAttribute("aria-hidden", "true");
        node.innerHTML = `<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="${path}"/>`;
        return node;
    };

    let dialog, root;
    // The live preview (below), if one is showing.
    let inspector;
    function open(pageId = "appearance") {
        if (!window.Lowcord.React || !window.Lowcord.createRoot) return;
        if (!dialog) build();
        show(pages.some(page => page.id === pageId) ? pageId : "appearance");
    }
    function build() {
        const backdrop = document.createElement("div");
        backdrop.className = "lowcord-settings-backdrop";
        backdrop.innerHTML = `<div class="lowcord-settings" role="dialog" aria-modal="true" aria-labelledby="lowcord-settings-title">
            <nav class="lowcord-settings-nav" aria-label="OrbitCord Settings"><h2 id="lowcord-settings-title">OrbitCord Settings</h2></nav>
            <div class="lowcord-settings-page"><header><h1></h1><button type="button" class="lowcord-settings-close" aria-label="Close OrbitCord Settings">×</button></header>
            <div class="lowcord-settings-body"></div></div></div>`;
        const nav = backdrop.querySelector("nav");
        for (const page of pages) {
            const button = document.createElement("button");
            button.type = "button";
            button.dataset.page = page.id;
            button.append(icon(page.icon), page.title);
            button.addEventListener("click", () => show(page.id));
            nav.append(button);
        }
        backdrop.querySelector(".lowcord-settings-close").addEventListener("click", close);
        backdrop.addEventListener("mousedown", event => { if (event.target === backdrop) close(); });
        dialog = backdrop;
    }
    // Esc closes Lowcord's dialog only, not Discord's settings underneath.
    // In a live preview it ends the preview first.
    window.addEventListener("keydown", event => {
        if (event.key !== "Escape") return;
        const details = document.querySelector(".lowcord-extension-details:popover-open");
        if (!details) return;
        event.preventDefault(); event.stopImmediatePropagation(); details.hidePopover();
    }, true);
    const onKey = event => {
        if (event.key !== "Escape") return;
        event.stopPropagation(); event.preventDefault();
        if (inspector) exitInspector(); else close();
    };
    function show(pageId) {
        const page = pages.find(entry => entry.id === pageId);
        if (!dialog.isConnected) {
            document.body.append(dialog);
            window.addEventListener("keydown", onKey, true);
        }
        dialog.querySelectorAll("nav button").forEach(button => button.setAttribute("aria-current", String(button.dataset.page === pageId)));
        dialog.querySelector("header h1").textContent = page.title;
        root?.unmount();
        root = window.Lowcord.createRoot(dialog.querySelector(".lowcord-settings-body"));
        root.render(window.Lowcord.React.createElement(page.component()));
        dialog.querySelector(`nav button[data-page="${pageId}"]`).focus();
    }
    function close() {
        exitInspector();
        root?.unmount();
        root = undefined;
        window.removeEventListener("keydown", onKey, true);
        dialog?.remove();
    }

    // Opened from Discord's sidebar, a page covers Discord's settings content
    // column from inside it, so it moves with Discord's open and close
    // animations. Discord's close button stays on top and works as usual.
    let inline;
    const selectedName = name => /^(selected|active)_/.test(name);
    function openInline(pageId, content, link) {
        if (!window.Lowcord.React || !window.Lowcord.createRoot) return;
        closeInline();
        close();
        const page = pages.find(entry => entry.id === pageId);
        const host = document.createElement("div");
        host.className = "lowcord-settings-inline";
        host.innerHTML = `<div class="lowcord-settings-page"><header><h1></h1></header><div class="lowcord-settings-body"></div></div>`;
        host.querySelector("h1").textContent = page.title;
        content.append(host);
        // CSS hides Discord's page under this marker. A class-substring
        // ancestor selector would restyle whole subtrees on every class change.
        content.setAttribute("data-lowcord-settings-host", "");
        // Discord's own selection moves to the Lowcord entry while it is open.
        const list = link.closest('ul[role="list"]');
        const previous = [...list.querySelectorAll('[role="link"]')].filter(node => node !== link && [...node.classList].some(selectedName));
        const removed = previous.map(node => [node, [...node.classList].filter(selectedName)]);
        removed.forEach(([node, names]) => node.classList.remove(...names));
        const selected = removed[0]?.[1] ?? [];
        link.classList.add(...selected);
        link.setAttribute("aria-current", "page");
        // Any other sidebar entry hands the content column back to Discord.
        const onClick = event => {
            const target = event.target.closest?.('[role="link"], [role="tab"]');
            if (target && target.closest("aside") && !target.closest(".lowcord-sidebar-section")) closeInline();
        };
        document.addEventListener("click", onClick, true);
        const pageRoot = window.Lowcord.createRoot(host.querySelector(".lowcord-settings-body"));
        pageRoot.render(window.Lowcord.React.createElement(page.component()));
        inline = { host, content, root: pageRoot, cleanup() {
            document.removeEventListener("click", onClick, true);
            content.removeAttribute("data-lowcord-settings-host");
            link.classList.remove(...selected);
            link.removeAttribute("aria-current");
            removed.forEach(([node, names]) => { if (node.isConnected) node.classList.add(...names); });
        } };
    }
    function closeInline() {
        exitInspector();
        if (!inline) return;
        const current = inline;
        inline = undefined;
        current.cleanup();
        current.root.unmount();
        current.host.remove();
    }
    window.Lowcord.onDomChange(() => {
        if (inline && !inline.host.isConnected) closeInline();
        if (inspector && !inspector.from.isConnected) exitInspector();
    });

    // Live preview: the settings window docks as a narrow panel on the right
    // and its dimming scrim lets clicks through, so Discord beside it stays
    // usable while a theme changes. Discord's tree is untouched; attributes
    // mark the window, the boxes between it and the page, and the scrim.
    const inspectorEvent = "lowcord-inspector-change";
    function enterInspector(from) {
        if (inspector) return true;
        const panel = from?.closest?.('[class*="modal_"], .lowcord-settings');
        if (!panel) return false;
        const marked = [];
        const mark = (node, name) => { if (!node) return; node.setAttribute(name, ""); marked.push([node, name]); };
        mark(panel, "data-lowcord-inspector-panel");
        for (let node = from.parentElement; node && node !== panel; node = node.parentElement) mark(node, "data-lowcord-inspector-fit");
        mark(panel.closest('[class*="layerContainer_"]')?.querySelector(':scope > [class*="scrim_"]') ?? panel.closest(".lowcord-settings-backdrop"),
            "data-lowcord-inspector-scrim");
        document.documentElement.setAttribute("data-lowcord-inspector", "");
        // Esc ends the preview, unless the user is typing in Discord itself.
        const onEscape = event => {
            if (event.key !== "Escape" || event.defaultPrevented || !(panel.contains(document.activeElement) || document.activeElement === document.body)) return;
            event.preventDefault(); event.stopImmediatePropagation();
            exitInspector();
        };
        window.addEventListener("keydown", onEscape, true);
        inspector = { from, cleanup() {
            marked.forEach(([node, name]) => node.removeAttribute(name));
            document.documentElement.removeAttribute("data-lowcord-inspector");
            window.removeEventListener("keydown", onEscape, true);
        } };
        window.dispatchEvent(new Event(inspectorEvent));
        return true;
    }
    function exitInspector() {
        if (!inspector) return;
        const current = inspector;
        inspector = undefined;
        current.cleanup();
        window.dispatchEvent(new Event(inspectorEvent));
    }
    window.__lowcordInspector = { enter: enterInspector, exit: exitInspector, get active() { return Boolean(inspector); }, changeEvent: inspectorEvent };

    // Mirror one of Discord's sidebar sections, reusing its class names so the
    // entry looks native. React never owns these nodes.
    let lastList;
    function placeSidebarSection(records) {
        if (!window.Lowcord.domChanged(records, 'aside[class*="sidebar_"]')) return;
        const list = document.querySelector('aside[class*="sidebar_"] nav ul[role="list"]');
        if (!list || (list === lastList && list.querySelector(":scope > .lowcord-sidebar-section"))) return;
        lastList = list;
        if (list.querySelector(":scope > .lowcord-sidebar-section")) return;
        // The first section (the account) has no heading; copy one that does.
        const first = list.querySelector(':scope > li[class*="section_"]');
        const sample = [...list.querySelectorAll(':scope > li[class*="section_"]')]
            .find(node => node.querySelector(':scope > [class*="sectionLabel_"] h3') && node.querySelector('ul[class*="sectionList_"] > li [role="link"]'));
        const label = sample?.querySelector('[class*="sectionLabel_"]');
        const heading = label?.querySelector("h3");
        const itemList = sample?.querySelector('ul[class*="sectionList_"]');
        const itemContainer = itemList?.querySelector(':scope > li');
        const item = itemContainer?.querySelector('[role="link"]');
        const content = item?.firstElementChild;
        const text = content?.querySelector("div:last-child");
        if (!text) return;
        const strip = node => [...node.classList].filter(name => !/^(active|selected)_/.test(name)).join(" ");
        const section = document.createElement("li");
        section.className = `${sample.className} lowcord-sidebar-section`;
        section.innerHTML = `<div class="${label.className}"><h3 class="${heading.className}" style="color: var(--text-muted);">OrbitCord</h3></div><ul class="${itemList.className}"></ul>`;
        for (const page of pages) {
            const entry = document.createElement("li");
            entry.className = itemContainer.className;
            entry.innerHTML = `<div class="${strip(item)}" role="link" tabindex="0"><div class="${content.className}"><div class="${text.className}" style="color: currentcolor;"></div></div></div>`;
            entry.querySelector(`.${CSS.escape(content.classList[0])}`).prepend(icon(page.icon));
            entry.querySelector(`.${CSS.escape(text.classList[0])}`).textContent = page.title;
            const link = entry.firstElementChild;
            const go = () => {
                const content = list.closest("aside")?.parentElement?.querySelector(':scope > [class*="content_"]');
                if (content) openInline(page.id, content, link); else open(page.id);
            };
            link.addEventListener("click", go);
            link.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); go(); } });
            section.lastElementChild.append(entry);
        }
        first.after(section);
    }
    window.Lowcord.onDomChange(placeSidebarSection);

    function mount() {
        const style = document.createElement("style");
        style.id = "lowcord-ui-css";
        style.textContent = lowcordUiCSS;
        document.head.append(style);
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
    else mount();
    window.__lowcordOpenSettings = open;
}
