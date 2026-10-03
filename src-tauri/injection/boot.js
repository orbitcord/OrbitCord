// Runs before the rest of Lowcord. The webview's canvas is white until the
// document paints, and Discord's theme class arrives only after its CSS.
(() => {
    if (window.self !== window.top || window.__LOWCORD_BOOT__) return;
    window.__LOWCORD_BOOT__ = true;
    let light = false;
    try {
        for (const key of ["theme", "ThemeStore"]) {
            const value = (localStorage.getItem(key) || "").toLowerCase();
            if (!value) continue;
            if (value.includes("dark") || value.includes("midnight")) light = false;
            else if (value.includes("light")) light = true;
        }
    } catch {}
    const style = document.createElement("style");
    style.id = "lowcord-boot";
    style.textContent = `html,body,#app-mount{background:${light ? "#ffffff" : "#313338"}!important;color-scheme:${light ? "light" : "dark"}}`;
    const attach = () => {
        const parent = document.head || document.documentElement;
        if (!parent) return false;
        if (!style.isConnected) parent.append(style);
        return true;
    };
    let observer;
    const release = () => {
        const mount = document.getElementById("app-mount");
        if (!mount || mount.childElementCount === 0 || !document.documentElement.className.includes("theme-")) return;
        style.remove();
        observer?.disconnect();
    };
    const watch = () => {
        const mount = document.getElementById("app-mount");
        if (!mount) return false;
        observer = new MutationObserver(release);
        observer.observe(mount, { childList: true });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
        release();
        return true;
    };
    let frame = 0;
    let stopped = false;
    const wait = () => {
        if (stopped) return;
        if (attach() && watch()) return;
        frame = requestAnimationFrame(wait);
    };
    if (!attach() || !watch()) frame = requestAnimationFrame(wait);
    setTimeout(() => {
        stopped = true;
        cancelAnimationFrame(frame);
        style.remove();
        observer?.disconnect();
    }, 20000);
})();
