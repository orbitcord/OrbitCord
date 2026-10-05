// OrbitCord Settings: a dialog of its own, opened from a "OrbitCord" section that
// is added to Discord's settings sidebar, or from the tray menu. Discord's
// settings screen is never re-rendered or patched.
function setupLowcordSettings() {
    if (window.__lowcordOpenSettings) return;
    const pages = [
        { id: "appearance", title: "Chat Appearance", icon: "M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z",
            component: () => window.__lowcordChatAppearance?.SettingsPanel },
        { id: "icon", title: "Icon", icon: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm4 6.5a1.5 1.5 0 1 0 0 .01M21 16l-5-5L5 21",
            component: () => IconPanel },
        { id: "extensions", title: "Extensions", icon: "M10 3a2 2 0 0 1 4 0v1h3a1 1 0 0 1 1 1v3h1a2 2 0 0 1 0 4h-1v3a1 1 0 0 1-1 1h-3v1a2 2 0 0 1-4 0v-1H7a1 1 0 0 1-1-1v-3H5a2 2 0 0 1 0-4h1V5a1 1 0 0 1 1-1h3V3Z",
            component: () => ExtensionsPanel },
    ];

    const appIcons = [["default", "Default"], ["disco", "Disco"], ["metal", "Metal"], ["mint", "Mint"], ["space", "Space"], ["sunny", "Sunny"]];
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
                ? "Pick an icon for OrbitCord. Updates the window, taskbar, tray and shortcuts."
                : "Pick an icon for OrbitCord. Your Dock or taskbar updates right away."),
            h("div", { className: "lowcord-icon-grid", role: "radiogroup", "aria-label": "App icon" }, ...appIcons.map(([id, label]) =>
                h("button", { key: id, type: "button", role: "radio", "aria-checked": current === id, className: "lowcord-icon-option", onClick: () => choose(id) },
                    current === id ? check : null,
                    previews[id] ? h("img", { src: previews[id], alt: "", width: 72, height: 72, draggable: false }) : h("span", { className: "lowcord-icon-placeholder" }),
                    h("span", { className: "lowcord-icon-name" }, label)))),
            h("p", { className: "lowcord-icon-note" }, windows
                ? "Desktop, Start menu and pinned shortcuts use your selected icon. The .exe file keeps the default icon."
                : "Finder and Explorer still show the default icon on the app file."),
            error ? h("p", { role: "alert" }, error) : null);
    }

    function ExtensionsPanel() {
        const { React } = window.Lowcord;
        const h = React.createElement;
        const extensions = window.Lowcord.extensions;
        const [state, setState] = React.useState(() => extensions.state);
        const [options, setOptions] = React.useState(() => extensions.options);
        const [error, setError] = React.useState("");
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
        return h("section", { className: "lowcord-chat-appearance" },
            h("p", { className: "lowcord-chat-intro" }, "Built-in OrbitCord extensions. Changes apply immediately."),
            h("div", { className: "lowcord-extension-list" }, ...extensions.catalog.map(({ id, title, description }) =>
                h("label", { key: id, className: "lowcord-chat-toggle" },
                    h("span", null, h("strong", null, title), h("span", { className: "lowcord-chat-description" }, description)),
                    h("input", { type: "checkbox", role: "switch", checked: state[id], onChange: event => {
                        try { extensions.set(id, event.target.checked); setError(""); } catch (failure) { setError(failure.message); }
                    } })))),
            h("label", { className: "lowcord-volume-card" },
                h("span", { className: "lowcord-volume-text" }, h("strong", null, "Embed volume"),
                    h("span", { className: "lowcord-chat-description" }, "YouTube, Spotify and Apple Music. Defaults to 50%.")),
                h("span", { className: "lowcord-volume-control" },
                    h("input", { type: "range", min: 0, max: 100, step: 1, value: options.musicVolume,
                        style: { "--lowcord-fill": `${options.musicVolume}%` },
                        "aria-label": "Embed volume", onChange: event => option("musicVolume", Number(event.target.value)) }),
                    h("output", null, `${options.musicVolume}%`))),
            state.socialEmbeds ? h("div", { className: "lowcord-embed-options" },
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
    const onKey = event => { if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); close(); } };
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
            link.classList.remove(...selected);
            link.removeAttribute("aria-current");
            removed.forEach(([node, names]) => { if (node.isConnected) node.classList.add(...names); });
        } };
    }
    function closeInline() {
        if (!inline) return;
        const current = inline;
        inline = undefined;
        current.cleanup();
        current.root.unmount();
        current.host.remove();
    }
    window.Lowcord.onDomChange(() => { if (inline && !inline.host.isConnected) closeInline(); });

    // Mirror one of Discord's sidebar sections, reusing its class names so the
    // entry looks native. React never owns these nodes.
    let lastList;
    function placeSidebarSection() {
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
