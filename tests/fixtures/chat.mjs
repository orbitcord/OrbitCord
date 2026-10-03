import * as React from "react";
import { createRoot } from "react-dom/client";

const picture = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="280" height="180"><rect width="280" height="180" fill="#267077"/><circle cx="200" cy="52" r="28" fill="#f7c984"/><path d="M0 180 90 60 170 180 220 110 280 180" fill="#163d4a"/></svg>');
const messages = {};
const listeners = new Map();
const fixture = window.fixture = {
    messages, channel: { type: 1 }, selected: "100", user: { id: "self" }, clicks: 0, replies: 0, drafts: [], sent: 0,
    emit() { for (const set of listeners.values()) for (const listener of set) listener(); },
    add(id, author, body, data = {}, reply = false) {
        messages[id] = { id: String(id), author: { id: author }, type: reply ? 19 : 0, timestamp: "2026-10-03T05:00:00Z", ...data };
        const row = document.createElement("li");
        row.id = `chat-messages-100-${id}`;
        row.innerHTML = `<div class="message_test" data-list-item-id="chat-messages___100-${id}" aria-label="${author} message"><div class="contents_test"><img class="avatar_test" src="${picture}" alt=""><h3 class="header_test">${author === "self" ? "You" : "Alex"} <time class="timestamp_test">10:30 AM</time></h3>${body}</div></div>`;
        if (reply) row.firstElementChild.insertAdjacentHTML("afterbegin", `<div class="repliedMessage_test"><span><img class="replyAvatar_test" alt="" src="${picture}"></span><span class="username_test">Alex</span><span class="repliedTextPreview_test"><span class="repliedTextContent_test" role="button" tabindex="0">How's your day going?</span></span></div>`);
        row.querySelector(".repliedTextContent_test")?.addEventListener("click", () => fixture.replies++);
        document.querySelector("#timeline").append(row);
        fixture.emit();
        return row;
    },
    // Discord renders attachments in a grid beside contents_, not inside it.
    accessories(row) {
        const accessories = row.querySelector(".contents_test > .container_test");
        if (!accessories) return;
        accessories.id = `message-accessories-${row.id.split("-").pop()}`;
        row.querySelector(".message_test").append(accessories);
    },
    toolbar(id, count = 4) {
        const surface = document.querySelector(`#chat-messages-100-${id} .message_test`);
        surface.insertAdjacentHTML("beforeend", `<div class="buttonContainer_test"><div class="buttons_test"><div class="buttonsInner_test">${Array.from({length:count}, (_, i) => `<button aria-label="${["React", "Reply", "Forward", "More"][i] ?? "Extra " + i}">${["☺", "↩", "→", "…"][i] ?? "…"}</button>`).join("")}</div></div></div>`);
        surface.querySelector('[aria-label="Reply"]').addEventListener("click", () => fixture.replies++);
    }
};
const stores = {
    SelectedChannelStore: { getChannelId: () => fixture.selected },
    ChannelStore: { getChannel: () => fixture.channel },
    UserStore: { getCurrentUser: () => fixture.user, getUser: id => ({ id, getAvatarURL: () => picture }) },
    MessageStore: { getMessage: (_, id) => messages[id] }
};
for (const [name, store] of Object.entries(stores)) {
    listeners.set(name, new Set());
    store.addChangeListener = fn => listeners.get(name).add(fn);
    store.removeChangeListener = fn => listeners.get(name).delete(fn);
}
const query = new URLSearchParams(location.search);
localStorage.clear();
if (query.has("legacy")) localStorage.setItem("VencordSettings", JSON.stringify({ plugins: { ChatBubbles: JSON.parse(query.get("legacy")) } }));
if (query.has("options")) localStorage.setItem("lowcord.dmChatAppearance", query.get("options"));
// The production hook finds these in Discord's webpack cache.
window.Lowcord = { storage: localStorage, React, waitForStore: (name, callback) => callback(stores[name]) };
document.addEventListener("DOMContentLoaded", () => {
    // Production injection supplies the CSS string alongside the script.
    fetch("/appearance.css").then(r => r.text()).then(css => {
        window.chatAppearanceCSS = css;
        if (query.get("theme") === "light") document.body.classList.add("light");
        fixture.add(1, "other", '<div class="messageContent_test">Hey! How’s your day going?</div>');
        fixture.add(2, "self", '<div class="messageContent_test">Pretty good!</div>');
        fixture.add(3, "self", '<div class="messageContent_test">What about you?</div>');
        fixture.add(4, "self", '<div class="messageContent_test">Long message ' + 'unbroken-message-'.repeat(query.has("overview") ? 2 : 80) + '</div>', {}, true);
        fixture.add(5, "other", `<div class="messageContent_test"><img class="emoji_test" src="${picture}" alt="emoji"> Inline emoji</div>`);
        fixture.add(6, "self", '<div class="messageContent_test"><pre><code>' + 'code '.repeat(query.has("overview") ? 6 : 100) + '</code></pre></div>');
        const reaction = document.createElement("button"); reaction.id = "reaction"; reaction.textContent = "👍 1";
        reaction.addEventListener("click", () => fixture.clicks++);
        document.querySelector("#chat-messages-100-2 .message_test").append(reaction);
        const media = [
            ["image", `<div class="imageWrapper_test"><img src="${picture}" alt="Sample image"></div>`, { attachments: [{ filename:"photo.png" }] }],
            ["gif", `<div class="imageWrapper_test"><img src="${picture}" alt="GIF preview"></div>`, { attachments: [{ filename:"animation.gif" }] }],
            ["video", '<video controls width="240" aria-label="Video attachment"></video>', { attachments: [{ filename:"clip.mp4" }] }],
            ["audio", '<audio controls aria-label="Audio attachment"></audio>', { attachments: [{ filename:"voice.ogg" }] }],
            ["file", '<div class="attachment_test"><a href="#download" class="download">document.pdf</a></div>', { attachments: [{ filename:"document.pdf" }] }],
            ["embed", '<div class="embedFull_test">A link preview</div>', { embeds: [{ type:"rich" }] }],
            ["sticker", `<img class="sticker_test" src="${picture}" width="80" alt="Sticker">`, { stickerItems: [{id:"7"}] }],
            ["forward", `<div class="messageSnapshot_test"><strong>↪ Forwarded</strong><p>A forwarded message</p><img src="${picture}" alt="Forwarded image"></div>`, { messageSnapshots:[{message:{content:"A forwarded message"}}] }],
            ["upload", '<div class="attachment_test upload_test"><span>📄</span><div class="uploadDetails_test">Uploading 2 Files<progress max="100" value="40"></progress></div><button class="cancel" aria-label="Cancel upload">×</button></div>', {}],
            ["caption", `<div class="messageContent_test">Photo with a caption</div><div class="imageWrapper_test"><img src="${picture}" alt="Captioned image"></div>`, {attachments:[{filename:"caption.jpg"}]}],
            ["forward-text", '<div class="messageSnapshot_test">↪ Forwarded text only</div>', {message_reference:{type:1}}],
            ["spoiler", `<div class="attachment_test spoiler_test"><button aria-label="Reveal spoiler">Spoiler</button><img hidden src="${picture}" alt="Spoiler image"></div>`, {attachments:[{filename:"SPOILER_image.png"}]}]
        ];
        for (const [index, [kind, body, data]] of media.entries()) {
            if (query.has("overview") && !["image", "forward", "upload"].includes(kind)) continue;
            for (const [side, author] of [[0, "other"], [1, "self"]]) {
                if (query.has("overview") && side === 0) continue;
                const row = fixture.add(10 + index * 2 + side, author, `<div class="container_test">${body}</div>`, data);
                fixture.accessories(row);
                row.dataset.media = kind;
                row.querySelector(".cancel")?.addEventListener("click", () => row.remove());
                row.querySelector('[aria-label="Reveal spoiler"]')?.addEventListener("click", event => { event.target.hidden = true; row.querySelector(".spoiler_test img").hidden = false; });
            }
        }
        fixture.add(90, "other", "Started a call", { type: 3 });
        fixture.add(91, "other", "Other timeline").id = "chat-messages-999-91";
        setupLowcordChatAppearance();
        createRoot(document.querySelector("#settings")).render(React.createElement(window.__lowcordChatAppearance.SettingsPanel));
        // A local stand-in for Discord's unchanged HTML5 draft handlers. The
        // Rust shell must hand File drops to this webview path, not consume them.
        const composer = document.querySelector("#composer");
        composer.addEventListener("dragover", event => { if (Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault(); });
        composer.addEventListener("drop", event => {
            if (!event.dataTransfer.files.length) return;
            event.preventDefault();
            fixture.drafts.push(...event.dataTransfer.files);
            document.querySelector("#drafts").replaceChildren(...fixture.drafts.map(file => {
                const preview = document.createElement("span"); preview.textContent = file.name; return preview;
            }));
        });
        document.querySelector("#send").addEventListener("click", () => {
            fixture.sent++;
            fixture.drafts = [];
            document.querySelector("#drafts").replaceChildren();
            document.querySelector("#sent").textContent = `${fixture.sent} sent`;
        });
    });
});
