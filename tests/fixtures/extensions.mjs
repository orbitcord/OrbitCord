import * as React from "react";
import { createRoot } from "react-dom/client";

// Discord supplies these through its module cache in production.
Object.defineProperty(window.Lowcord, "React", { value: React });
Object.defineProperty(window.Lowcord, "createRoot", { value: createRoot });
(async () => {
    const [appearance, ui] = await Promise.all([fetch("/appearance.css").then(r => r.text()), fetch("/injection/lowcord-ui.css").then(r => r.text())]);
    window.chatAppearanceCSS = appearance;
    window.lowcordUiCSS = ui;
    for (const path of ["/appearance.js", "/injection/settings.js"]) {
        const script = document.createElement("script");
        script.textContent = await (await fetch(path)).text();
        document.head.append(script);
    }
    setupLowcordChatAppearance();
    setupLowcordSettings();
    window.fixtureReady = true;
})();
