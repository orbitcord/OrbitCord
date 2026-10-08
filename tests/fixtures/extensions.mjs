import * as React from "react";
import { createRoot } from "react-dom/client";

// Discord supplies these through its module cache in production.
Object.defineProperty(window.Lowcord, "React", { value: React });
Object.defineProperty(window.Lowcord, "createRoot", { value: createRoot });
(async () => {
    const [themes, appearance, ui] = await Promise.all(["/injection/themes.css", "/appearance.css", "/injection/lowcord-ui.css"]
        .map(path => fetch(path).then(r => r.text())));
    window.themesCSS = themes;
    window.chatAppearanceCSS = appearance;
    window.lowcordUiCSS = ui;
    for (const path of ["/injection/themes.js", "/appearance.js", "/injection/settings.js"]) {
        const script = document.createElement("script");
        script.textContent = await (await fetch(path)).text();
        document.head.append(script);
    }
    setupLowcordThemes();
    setupLowcordChatAppearance();
    setupLowcordSettings();
    window.fixtureReady = true;
})();
