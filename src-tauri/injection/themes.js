// OrbitCord themes. A theme points Discord's own design tokens at a new
// palette and adds a few region rules. Only the active theme's CSS is ever in
// the page, and once it is applied no script, observer or timer runs for it.
// With Discord's own look selected, nothing is added at all.
function setupLowcordThemes() {
    if (window.__lowcordThemes) return;
    const storage = window.Lowcord?.storage;
    const storageKey = "lowcord.theme";
    const changeEvent = "lowcord-theme-change";
    // System typefaces only, nothing is downloaded. Each stack pairs a macOS
    // face with the closest one Windows ships, then a Linux fallback.
    const system = '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
    const systemMono = 'Menlo, Consolas, "DejaVu Sans Mono", monospace';
    const themes = [
        { id: "fjord", name: "Fjord", scheme: "dark", blurb: "Slate blues and a frost accent. Cool and calm.",
            fonts: { ui: `"Helvetica Neue", "Segoe UI Variable Text", "Segoe UI", Helvetica, Arial, sans-serif`, code: systemMono }, radius: 10,
            palette: { frame: "#1a1e26", sidebar: "#20252e", chat: "#252a34", surface: "#2d333f", raised: "#303744", border: "#3a4252",
                selection: "#3b4f66", mention: "#26323f", text: "#e5e9f0", muted: "#8f99ab", accent: "#88c0d0", accentHover: "#a3d0dd",
                onAccent: "#132029", link: "#8fcbdb", success: "#a3be8c", warning: "#ebcb8b", danger: "#d27b84", code: "#1f242d",
                bubbleOut: "#5e81ac", bubbleOutText: "#f4f7fb", bubbleIn: "#353c4a", bubbleInText: "#e5e9f0" } },
        { id: "ember", name: "Ember", scheme: "dark", blurb: "Warm charcoal lit by a low amber glow.",
            fonts: { ui: `"Gill Sans", "Gill Sans MT", Calibri, ${system}`, code: systemMono }, radius: 10,
            palette: { frame: "#141211", sidebar: "#1a1816", chat: "#1f1c1a", surface: "#282421", raised: "#2c2825", border: "#38322d",
                selection: "#5a4024", mention: "#2c2218", text: "#ece4da", muted: "#9c9189", accent: "#e8a25c", accentHover: "#f0b679",
                onAccent: "#1c1208", link: "#f0b679", success: "#a9bf7e", warning: "#e8c46b", danger: "#e07b6a", code: "#191715",
                bubbleOut: "#e8a25c", bubbleOutText: "#1c1208", bubbleIn: "#2f2a26", bubbleInText: "#ece4da" } },
        { id: "moss", name: "Moss", scheme: "dark", blurb: "Soft forest greens with sage and wheat.",
            fonts: { ui: `"Trebuchet MS", ${system}`, code: systemMono }, radius: 10,
            palette: { frame: "#191d1a", sidebar: "#1f2420", chat: "#242a26", surface: "#2c332e", raised: "#303832", border: "#39433c",
                selection: "#44523b", mention: "#2e3024", text: "#d9ddd0", muted: "#909a8d", accent: "#a7c080", accentHover: "#bcd39a",
                onAccent: "#172013", link: "#b5cd8f", success: "#a7c080", warning: "#dbbc7f", danger: "#e67e80", code: "#1e2320",
                bubbleOut: "#a7c080", bubbleOutText: "#172013", bubbleIn: "#323a34", bubbleInText: "#d9ddd0" } },
        { id: "velvet", name: "Velvet Dusk", scheme: "dark", blurb: "Soft dusk purples with rose and gold.",
            fonts: { ui: `"Figtree", ${system}`, display: `"Fraunces", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif`,
                code: `"Fira Code", ${systemMono}` },
            radius: 10,
            palette: { frame: "#191724", sidebar: "#1f1d2e", chat: "#232136", surface: "#2a273f", raised: "#2a273f", border: "#393552",
                selection: "#44415a", mention: "#392d41", text: "#e0def4", muted: "#908caa", accent: "#c4a7e7", accentHover: "#d6c2f1",
                onAccent: "#191724", link: "#c4a7e7", success: "#9ccfd8", warning: "#f6c177", danger: "#eb6f92", code: "#1f1d2e",
                bubbleOut: "#c4a7e7", bubbleOutText: "#191724", bubbleIn: "#393552", bubbleInText: "#e0def4" } },
        { id: "phosphor", name: "Phosphor", scheme: "dark", blurb: "Monospace everything, one cobalt accent.",
            fonts: { ui: systemMono, code: systemMono },
            radius: 0, xHeight: .44,
            palette: { frame: "#050506", sidebar: "#08090a", chat: "#0b0c0e", surface: "#131518", raised: "#101114", border: "#24272d",
                selection: "#152645", mention: "#0f1726", text: "#e6e8eb", muted: "#8b9099", accent: "#4d8dff", accentHover: "#7aa9ff",
                onAccent: "#050506", link: "#7aa9ff", success: "#8fae9c", warning: "#c4b083", danger: "#d48a8a", code: "#08090a",
                bubbleOut: "#2f6bd8", bubbleOutText: "#ffffff", bubbleIn: "#131518", bubbleInText: "#e6e8eb" } },
    ];
    // Discord's own look, shown first in the picker. Its preview stands for
    // whichever Appearance the user picked in Discord.
    const discord = { id: "discord", name: "Discord", blurb: "Discord’s own look. Follows your Appearance settings.",
        radius: 8, palette: { frame: "#121214", sidebar: "#121214", chat: "#1a1a1e", surface: "#242429", border: "#2e2e34",
            mention: "#2b2a22", text: "#dfe0e2", muted: "#94959c", accent: "#5865f2", warning: "#f0b232" } };

    // The user's own theme. They pick a background, an accent and optionally
    // the text; every other palette color is shaded from those, so any pick
    // stays readable. It has no fonts of its own: the typeface setting applies.
    const hex = /^#[0-9a-f]{6}$/i;
    const corners = [["Square", 0], ["Soft", 8], ["Round", 14]];
    // Chat bubble corners for each choice, and the tighter corner where
    // grouped bubbles meet. Soft keeps OrbitCord's usual 18px bubble.
    const bubbleCorners = { 0: [4, 2], 8: [18, 4], 14: [24, 4] };
    const customDefaults = { background: "#1e1f24", accent: "#5865f2", text: null, radius: 8 };
    const channels = value => [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16));
    const mix = (from, to, amount) => {
        const a = channels(from), b = channels(to);
        return `#${a.map((value, index) => Math.round(value + (b[index] - value) * amount).toString(16).padStart(2, "0")).join("")}`;
    };
    const luminance = value => {
        const [r, g, b] = channels(value).map(channel => {
            channel /= 255;
            return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
        });
        return .2126 * r + .7152 * g + .0722 * b;
    };
    const contrast = (a, b) => {
        const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (light + .05) / (dark + .05);
    };
    // Starting points: each preset, plus two light ones.
    const seeds = [["Discord", "#1a1a1e", "#5865f2", null, 8], ["Paper", "#f6f3ee", "#c2562b", "#2b2622", 8], ["Cloud", "#ffffff", "#3b6fe0", null, 14],
        ...themes.map(theme => [theme.name, theme.palette.chat, theme.palette.accent, theme.palette.text, theme.radius ? 8 : 0])]
        .map(([name, background, accent, text, radius]) => ({ name, custom: { background, accent, text, radius } }));
    function customTheme(custom) {
        const { background, accent } = custom;
        const dark = luminance(background) < .18;
        const text = custom.text ?? (dark ? mix("#ffffff", background, .1) : mix("#060607", background, .12));
        const shade = amount => mix(background, "#000000", dark ? amount : amount / 5);
        const lift = amount => mix(background, text, amount);
        const onAccent = contrast(accent, "#ffffff") >= 3 ? "#ffffff" : mix("#000000", accent, .2);
        return { id: "custom", name: "Custom", scheme: dark ? "dark" : "light", blurb: "Your own colors. Make it below.",
            radius: custom.radius, bubbleCorners: bubbleCorners[custom.radius],
            palette: { frame: shade(.32), sidebar: shade(.16), chat: background, surface: lift(.06), raised: lift(.08), border: lift(.15),
                selection: mix(background, accent, .4), mention: mix(background, accent, .12), text, muted: mix(text, background, .42),
                accent, accentHover: mix(accent, dark ? "#ffffff" : "#000000", .16), onAccent,
                link: mix(accent, dark ? "#ffffff" : "#000000", .2),
                success: dark ? "#6fbf8a" : "#2f8a4f", warning: dark ? "#e3b55b" : "#a8740f", danger: dark ? "#e0787c" : "#c6383f",
                code: shade(.2), bubbleOut: accent, bubbleOutText: onAccent, bubbleIn: lift(.1), bubbleInText: text } };
    }

    // System fonts offered for all of Discord. Only the ones this computer
    // has are listed, so each renders as itself.
    const fontChoices = [
        { label: "Sans serif", fonts: [["System", system], ["Helvetica Neue", `"Helvetica Neue", Helvetica, Arial, sans-serif`],
            ["Avenir Next", `"Avenir Next", sans-serif`], ["Gill Sans", `"Gill Sans", "Gill Sans MT", sans-serif`], ["Optima", "Optima, sans-serif"],
            ["Futura", "Futura, sans-serif"], ["Segoe UI", `"Segoe UI Variable Text", "Segoe UI", sans-serif`], ["Calibri", "Calibri, sans-serif"],
            ["Candara", "Candara, sans-serif"], ["Corbel", "Corbel, sans-serif"], ["Bahnschrift", "Bahnschrift, sans-serif"],
            ["Trebuchet MS", `"Trebuchet MS", sans-serif`], ["Verdana", "Verdana, sans-serif"], ["Tahoma", "Tahoma, sans-serif"],
            ["Arial", "Arial, sans-serif"], ["Ubuntu", "Ubuntu, sans-serif"], ["Noto Sans", `"Noto Sans", sans-serif`],
            ["Cantarell", "Cantarell, sans-serif"], ["DejaVu Sans", `"DejaVu Sans", sans-serif`]] },
        { label: "Serif", fonts: [["Georgia", "Georgia, serif"], ["Iowan Old Style", `"Iowan Old Style", serif`],
            ["Palatino", `Palatino, "Palatino Linotype", serif`], ["Cambria", "Cambria, serif"], ["Constantia", "Constantia, serif"],
            ["Times New Roman", `"Times New Roman", serif`]] },
        { label: "Monospace", fonts: [["Menlo", "Menlo, monospace"], ["Consolas", "Consolas, monospace"],
            ["DejaVu Sans Mono", `"DejaVu Sans Mono", monospace`], ["Courier New", `"Courier New", monospace`]] },
    ].map(group => ({ label: group.label, fonts: group.fonts.map(([name, stack]) => ({ name, stack })) }));
    const fontStack = name => fontChoices.flatMap(group => group.fonts).find(choice => choice.name === name)?.stack;
    // A font is installed when text set in it measures differently from the
    // fallbacks. Measured once, when the setting is first shown.
    let installed;
    function installedFonts() {
        if (!installed) {
            const context = document.createElement("canvas").getContext("2d");
            const width = family => { context.font = `72px ${family}`; return context.measureText("mmmmmlliWQ@ 0123").width; };
            const fallbacks = ["monospace", "serif", "sans-serif"].map(family => [family, width(family)]);
            const has = name => fallbacks.some(([family, base]) => width(`"${name}", ${family}`) !== base);
            const families = stack => stack.split(",").map(part => part.trim().replace(/^"|"$/g, ""))
                .filter(name => !/^(serif|sans-serif|monospace)$/.test(name));
            installed = fontChoices.map(group => ({ label: group.label,
                fonts: group.fonts.filter(choice => choice.name === "System" || families(choice.stack).some(has)) }))
                .filter(group => group.fonts.length);
        }
        return installed;
    }

    // themes.css: a shared block, then blocks marked `/* @theme <id> … */`
    // for the themes they belong to.
    const sections = { shared: "" };
    {
        const parts = themesCSS.split(/^\/\*\s*@theme\s+([\w -]+?)\s*\*\/\s*$/m);
        sections.shared = parts[0];
        for (let i = 1; i < parts.length; i += 2) {
            for (const id of parts[i].split(/\s+/)) sections[id] = (sections[id] ?? "") + parts[i + 1];
        }
    }
    const kebab = name => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
    function paletteCSS(theme) {
        const scope = `:root[data-orbitcord-theme="${theme.id}"]`;
        const palette = { rail: theme.palette.frame, ...theme.palette };
        const values = Object.entries(palette).map(([name, value]) => `--oc-${kebab(name)}:${value}`);
        const scrim = theme.scheme === "dark" ? "rgb(0 0 0 / .7)" : "rgb(20 20 28 / .36)";
        // Text is scaled to Discord's own x-height (gg sans, .47), so a
        // fallback font is never larger than Discord's.
        const fonts = theme.fonts ? `;--oc-x-height:${theme.xHeight ?? .47};--oc-font:${theme.fonts.ui};`
            + `--oc-font-display:${theme.fonts.display ?? theme.fonts.ui};--oc-font-code:${theme.fonts.code}` : "";
        const bubbles = theme.bubbleCorners ? `;--oc-bubble-radius:${theme.bubbleCorners[0]}px;--oc-bubble-stack:${theme.bubbleCorners[1]}px` : "";
        return `${scope}{color-scheme:${theme.scheme};${values.join(";")};--oc-radius:${theme.radius}px;--oc-scrim:${scrim}${fonts}${bubbles}}\n`;
    }

    function normalize(value) {
        const saved = value?.custom ?? {};
        const color = (name, fallback) => hex.test(saved[name] ?? "") ? saved[name].toLowerCase() : fallback;
        const custom = { background: color("background", customDefaults.background), accent: color("accent", customDefaults.accent),
            text: color("text", null), radius: corners.some(([, radius]) => radius === saved.radius) ? saved.radius : customDefaults.radius };
        return { id: value?.id === "custom" || themes.some(theme => theme.id === value?.id) ? value.id : "discord",
            fonts: value?.fonts !== false, bubbles: value?.bubbles !== false, font: fontStack(value?.font) ? value.font : "", custom };
    }
    const themeFor = id => id === "custom" ? customTheme(state.custom) : themes.find(entry => entry.id === id);
    let state;
    try { state = normalize(JSON.parse(storage?.getItem(storageKey) ?? "null")); }
    catch { state = normalize(null); }

    const style = document.createElement("style");
    style.id = "lowcord-theme";
    let renderedKey;
    function render() {
        const root = document.documentElement;
        const theme = themeFor(state.id);
        const stack = fontStack(state.font);
        if (!theme && !stack) {
            style.remove();
            style.textContent = "";
            renderedKey = undefined;
            for (const name of ["data-orbitcord-theme", "data-orbitcord-theme-fonts", "data-orbitcord-theme-bubbles", "data-orbitcord-font"]) root.removeAttribute(name);
            return;
        }
        const key = `${theme?.id}|${state.font}|${theme?.id === "custom" ? JSON.stringify(state.custom) : ""}`;
        if (renderedKey !== key) {
            // The chosen font outranks a theme's own and keeps Discord's text size.
            style.textContent = (theme ? paletteCSS(theme) + sections.shared + (sections[theme.id] ?? "") : "")
                + (stack ? `:root:root[data-orbitcord-font]{--font-primary:${stack};--font-display:${stack};--font-headline:${stack};`
                    + "font-size-adjust:ex-height .47}\n" : "");
            renderedKey = key;
        }
        root.toggleAttribute("data-orbitcord-font", Boolean(stack));
        if (!theme) {
            for (const name of ["data-orbitcord-theme", "data-orbitcord-theme-fonts", "data-orbitcord-theme-bubbles"]) root.removeAttribute(name);
            if (!style.isConnected) (document.head ?? root).append(style);
            return;
        }
        root.setAttribute("data-orbitcord-theme", theme.id);
        root.toggleAttribute("data-orbitcord-theme-fonts", state.fonts && Boolean(theme.fonts));
        root.toggleAttribute("data-orbitcord-theme-bubbles", state.bubbles);
        // Before Discord's <head> exists the sheet sits under <html>, like
        // the boot style. Its selectors outrank Discord's, so order is moot.
        if (!style.isConnected) (document.head ?? root).append(style);
        // The boot style paints the window until Discord's CSS arrives.
        const boot = window.__lowcordBootStyle;
        if (boot) boot.textContent = `html,body,#app-mount{background:${theme.palette.frame}!important;color-scheme:${theme.scheme}}`;
    }
    // At document start <html> may not exist yet.
    const start = () => { try { render(); } catch (error) { console.error("[Lowcord] Theme:", error); } };
    if (document.documentElement) start();
    else {
        const waiting = new MutationObserver(() => {
            if (!document.documentElement) return;
            waiting.disconnect();
            start();
        });
        waiting.observe(document, { childList: true });
    }

    function change(next) {
        const before = state;
        const after = normalize({ ...state, ...next, custom: { ...state.custom, ...next.custom } });
        try { storage.setItem(storageKey, JSON.stringify(after)); }
        catch { throw new Error("Couldn’t save this setting. Please try again."); }
        state = after;
        // A new theme cross-fades the whole window once. Only the switch
        // itself uses the GPU; nothing keeps running afterwards.
        const fade = before.id !== after.id && typeof document.startViewTransition === "function"
            && document.visibilityState === "visible" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (fade) document.startViewTransition(render);
        else render();
        window.dispatchEvent(new Event(changeEvent));
    }

    function ThemesPanel() {
        const { React } = window.Lowcord;
        const h = React.createElement;
        const [current, setCurrent] = React.useState(() => ({ ...state }));
        const [error, setError] = React.useState("");
        const fonts = React.useMemo(() => installedFonts(), []);
        React.useEffect(() => {
            const update = () => setCurrent({ ...state });
            window.addEventListener(changeEvent, update);
            return () => window.removeEventListener(changeEvent, update);
        }, []);
        const save = next => { try { change(next); setError(""); } catch (failure) { setError(failure.message); } };
        const custom = customTheme(current.custom);
        const choices = [discord, ...themes, custom];
        const active = themeFor(current.id);
        // Any edit to the custom theme also selects it, so the change shows.
        const edit = value => save({ id: "custom", custom: value });
        // Arrow keys move through the grid like any radio group; up and down
        // move by a row.
        const arrow = event => {
            const cards = [...event.currentTarget.parentElement.children];
            const index = cards.indexOf(event.currentTarget);
            const columns = cards.filter(card => card.offsetTop === cards[0].offsetTop).length || 1;
            const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[event.key];
            const target = event.key === "Home" ? 0 : event.key === "End" ? cards.length - 1 : step ? index + step : -1;
            if (target < 0 || target >= cards.length || target === index) return;
            event.preventDefault();
            save({ id: choices[target].id });
            cards[target].focus();
        };
        const description = text => h("span", { className: "lowcord-chat-description" }, text);
        const card = theme => {
            const selected = current.id === theme.id;
            const palette = theme.palette;
            const vars = { "--t-frame": palette.frame, "--t-rail": palette.rail ?? palette.frame, "--t-sidebar": palette.sidebar,
                "--t-chat": palette.chat, "--t-surface": palette.surface, "--t-border": palette.border, "--t-mention": palette.mention,
                "--t-text": palette.text, "--t-muted": palette.muted, "--t-accent": palette.accent, "--t-radius": `${theme.radius}px`,
                "--t-font": theme.fonts?.display ?? theme.fonts?.ui ?? "inherit" };
            const line = (width, tone = "muted") => h("i", { className: `lowcord-theme-line is-${tone}`, style: { width } });
            const message = (width, mention) => h("span", { className: "lowcord-theme-message", "data-mention": mention || undefined },
                h("b", { className: "lowcord-theme-avatar" }),
                h("span", null, line("34%", "text"), line(width)));
            return h("button", { key: theme.id, type: "button", role: "radio", "aria-checked": selected, tabIndex: selected ? 0 : -1,
                    className: "lowcord-theme-card", "data-theme-card": theme.id, style: vars,
                    onClick: () => save({ id: theme.id }), onKeyDown: arrow },
                h("span", { className: "lowcord-theme-preview", "aria-hidden": true },
                    h("span", { className: "lowcord-theme-rail" }, h("b", null), h("b", null), h("b", null), h("b", null)),
                    h("span", { className: "lowcord-theme-sidebar" }, line("62%", "text"), line("70%"), line("54%", "selected"), line("66%"), line("48%")),
                    h("span", { className: "lowcord-theme-chat" },
                        h("span", { className: "lowcord-theme-header" }, line("28%", "text")),
                        message("78%"), message("58%", true), message("68%"),
                        h("span", { className: "lowcord-theme-composer" }, h("b", null)))),
                h("span", { className: "lowcord-theme-label" },
                    h("span", { className: "lowcord-theme-name" }, theme.name),
                    h("span", { className: "lowcord-theme-scheme" }, { dark: "Dark", light: "Light" }[theme.scheme] ?? "Default")),
                h("span", { className: "lowcord-theme-blurb" }, theme.blurb),
                selected ? h("svg", { className: "lowcord-theme-check", viewBox: "0 0 16 16", width: 18, height: 18, "aria-hidden": "true" },
                    h("circle", { cx: 8, cy: 8, r: 8, fill: "currentColor" }),
                    h("path", { d: "m4.8 8.3 2.1 2.1 4.3-4.5", fill: "none", stroke: "var(--lowcord-check-ink, #fff)", strokeWidth: 1.8,
                        strokeLinecap: "round", strokeLinejoin: "round" })) : null);
        };

        // The custom theme's editor: three colors, a starting point, corners.
        const color = (key, title, value, hint, auto) => h("div", { key, className: "lowcord-theme-color", title: hint },
            h("label", { className: "lowcord-theme-color-pick" },
                h("span", { className: "lowcord-color-swatch", style: { "--lowcord-swatch": value } },
                    h("input", { type: "color", value, "aria-label": `${title} color`, onChange: event => edit({ [key]: event.target.value }) })),
                h("span", { className: "lowcord-theme-color-text" }, h("strong", null, title), h("code", null, value.toUpperCase()))),
            auto === undefined ? null : auto ? h("span", { className: "lowcord-color-auto" }, "Auto")
                : h("button", { type: "button", className: "lowcord-color-auto", "aria-label": "Use automatic text color",
                    onClick: () => edit({ text: null }) }, "Auto"));
        const matches = seed => Object.entries(seed.custom).every(([name, value]) => current.custom[name] === value);
        const editor = h("div", { className: "lowcord-theme-editor", "data-active": current.id === "custom" },
            h("div", { className: "lowcord-theme-editor-head" },
                h("span", null, h("h3", null, "Make your own"),
                    description("Pick a background and an accent, and OrbitCord shades everything else from them.")),
                current.id === "custom" ? null
                    : h("button", { type: "button", className: "lowcord-theme-use", onClick: () => save({ id: "custom" }) }, "Use custom theme")),
            h("div", { className: "lowcord-theme-colors" },
                color("background", "Background", custom.palette.chat, "Chat, with sidebars shaded from it"),
                color("accent", "Accent", custom.palette.accent, "Buttons, links, your bubbles"),
                color("text", "Text", custom.palette.text, "Messages and labels; muted text is mixed from it", !current.custom.text)),
            h("div", { className: "lowcord-theme-editor-row" },
                h("span", { className: "lowcord-theme-editor-label" }, "Start from"),
                h("div", { className: "lowcord-theme-seeds" }, ...seeds.map(seed => h("button", { key: seed.name, type: "button",
                        className: "lowcord-theme-seed", "aria-pressed": matches(seed), onClick: () => edit(seed.custom),
                        style: { "--seed-background": seed.custom.background, "--seed-accent": seed.custom.accent } },
                    h("b", { "aria-hidden": true }), seed.name)))),
            h("div", { className: "lowcord-theme-editor-row" },
                h("span", { className: "lowcord-theme-editor-label", id: "lowcord-theme-corners" }, "Corners"),
                h("div", { className: "lowcord-segmented", role: "radiogroup", "aria-labelledby": "lowcord-theme-corners" },
                    ...corners.map(([label, radius]) => h("button", { key: radius, type: "button", role: "radio",
                        "aria-checked": current.custom.radius === radius, onClick: () => edit({ radius }) },
                        h("i", { className: "lowcord-theme-corner", style: { "--corner": `${radius / 2}px` }, "aria-hidden": true }), label)))));

        // One typeface control for every theme. "" keeps the theme's own (or
        // Discord's); "discord" turns a theme's typefaces off.
        const themeFonts = Boolean(active?.fonts);
        const typeface = current.font || (themeFonts && !current.fonts ? "discord" : "");
        const setTypeface = value => save(value === "discord" ? { font: "", fonts: false } : { font: value, fonts: true });
        const sample = fontStack(current.font) ?? (themeFonts && current.fonts ? active.fonts.ui : undefined);
        const options = h("div", { className: "lowcord-theme-options" },
            h("h3", null, "Text and bubbles"),
            h("div", { className: "lowcord-theme-typeface" },
                h("label", { className: "lowcord-position-control" },
                    h("span", null, h("strong", null, "Typeface"),
                        description("Used across Discord, over any theme. Only fonts installed on this computer are listed.")),
                    h("select", { value: typeface, "aria-label": "Typeface", onChange: event => setTypeface(event.target.value) },
                        h("option", { value: "" }, themeFonts ? `${active.name}’s own` : "Discord’s"),
                        themeFonts ? h("option", { value: "discord" }, "Discord’s") : null,
                        ...fonts.map(group => h("optgroup", { key: group.label, label: group.label },
                            ...group.fonts.map(choice => h("option", { key: choice.name, value: choice.name }, choice.name)))))),
                h("p", { className: "lowcord-font-sample", style: { fontFamily: sample } },
                    "The quick brown fox jumps over the lazy dog. 0123456789")),
            h("label", { className: "lowcord-chat-toggle", "data-off": !active },
                h("span", null, h("strong", null, "Theme chat bubbles"),
                    description("Color OrbitCord’s chat bubbles to match the theme instead of your own bubble colors.")),
                h("input", { type: "checkbox", role: "switch", checked: current.bubbles, disabled: !active,
                    onChange: event => save({ bubbles: event.target.checked }) })));
        return h("section", { className: "lowcord-chat-appearance lowcord-themes-page" },
            h("p", { className: "lowcord-chat-intro" },
                "Restyle all of Discord. Themes are plain CSS, so they add no background work and switch instantly."),
            h("div", { className: "lowcord-theme-grid", role: "radiogroup", "aria-label": "Theme" }, ...choices.map(card)),
            editor, options,
            error ? h("p", { role: "alert" }, error) : null);
    }
    ThemesPanel.displayName = "Themes";

    window.__lowcordThemes = {
        get catalog() {
            return [...themes, customTheme(state.custom)].map(({ id, name, scheme, palette }) => ({ id, name, scheme,
                bubbles: { outgoingColor: palette.bubbleOut, outgoingTextColor: palette.bubbleOutText,
                    incomingColor: palette.bubbleIn, incomingTextColor: palette.bubbleInText } }));
        },
        get state() { return { ...state, custom: { ...state.custom } }; }, set: change, fonts: installedFonts, changeEvent, SettingsPanel: ThemesPanel };
}
