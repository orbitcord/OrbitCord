import { test, expect } from "@playwright/test";

// Tests run in parallel against one server, so each uses its own channel id
// and only reads back the requests that carry it.
let channel = 0;
test.beforeEach(async ({ page }, info) => {
    channel = 1000 + info.workerIndex * 1000 + info.repeatEachIndex + Math.floor(Math.random() * 900);
    await page.goto("/extensions");
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
});
const received = async page => (await (await page.request.get("/__received")).json())
    .filter(entry => entry.path.includes(`/${channel}`) || entry.path.includes(`c=${channel}`));
const xhr = (page, method, path, body, type = "application/json") => page.evaluate(([method, path, body, type]) => new Promise(resolve => {
    const request = new XMLHttpRequest();
    request.open(method, path);
    if (type) request.setRequestHeader("Content-Type", type);
    request.onreadystatechange = () => { if (request.readyState === 4) resolve(request.status); };
    request.send(body);
}), [method, path, body, type]);
const setExtension = (page, id, value) => page.evaluate(([id, value]) => Lowcord.extensions.set(id, value), [id, value]);

test("desktop download shortcut is hidden without affecting servers or attachment downloads", async ({ page }) => {
    await page.evaluate(() => {
        const fixture = document.createElement("div");
        fixture.innerHTML = `<nav class="guilds_test">
            <div class="listItem_test" id="server-item"><button aria-label="Test server">Server</button></div>
            <div class="listItem_test" id="download-item"><div aria-label="Download Apps" tabindex="0">Download</div></div>
            <div class="downloadApp_test" id="localized-download"><button aria-label="Télécharger les applications">Download</button></div>
        </nav><div class="attachment_test"><a href="#download" aria-label="Download Apps">Download</a></div>`;
        document.body.append(fixture);
    });
    await expect(page.locator("#download-item")).toBeHidden();
    await expect(page.locator("#localized-download")).toBeHidden();
    await expect(page.locator("#server-item")).toBeVisible();
    await expect(page.locator('.attachment_test a')).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.locator('[aria-label="Download Apps"]').first()).not.toBeFocused();
});

test("every extension is on by default and persists when switched", async ({ page }) => {
    const state = await page.evaluate(() => Lowcord.extensions.state);
    expect(state).toMatchObject({
        anonymiseFileNames: true, voiceMessages: true, quickReply: true, cleanUrls: true, silentTyping: true, noTracking: true,
        youtubeAdblock: true, musicEmbeds: true, socialEmbeds: true, socialCards: true, redditVideoUpload: true, instagramVideoUpload: true, twitterVideoUpload: true });
    expect(Object.values(state).every(value => value === true)).toBe(true);
    await setExtension(page, "silentTyping", false);
    await page.reload();
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
    expect(await page.evaluate(() => Lowcord.extensions.enabled("silentTyping"))).toBe(false);
});

test("silent typing answers Discord's typing request locally, over XHR and fetch", async ({ page }) => {
    expect(await xhr(page, "POST", `/api/v9/channels/${channel}/typing`, "")).toBe(204);
    expect(await page.evaluate(path => fetch(path, { method: "POST" }).then(r => r.status), `/api/v9/channels/${channel}/typing`)).toBe(204);
    expect(await received(page)).toEqual([]);
    await setExtension(page, "silentTyping", false);
    expect(await xhr(page, "POST", `/api/v9/channels/${channel}/typing`, "")).toBe(200);
    expect((await received(page)).map(entry => entry.path)).toEqual([`/api/v9/channels/${channel}/typing`]);
});

test("no tracking blocks analytics, metrics, crash reports and the desktop RPC probe", async ({ page }) => {
    for (const path of ["/api/v9/science", "/api/v9/metrics/v2", "/api/v10/track", "/error-reporting-proxy/web"]) {
        expect(await xhr(page, "POST", `${path}?c=${channel}`, "{}")).toBe(204);
    }
    expect(await page.evaluate(() => navigator.sendBeacon(`/api/v9/science?c=1`, "{}"))).toBe(true);
    expect(await page.evaluate(() => { try { new WebSocket("ws://127.0.0.1:6463/?v=1"); return "opened"; } catch (error) { return error.name; } })).toBe("SecurityError");
    expect(await page.evaluate(() => fetch("http://127.0.0.1:6464/rpc?v=1", { method: "POST" }).then(() => "sent", error => error.name))).toBe("TypeError");
    expect(await xhr(page, "GET", `/api/v9/channels/${channel}/messages`, null, null)).toBe(200);
    expect((await received(page)).map(entry => entry.path)).toEqual([`/api/v9/channels/${channel}/messages`]);
    await setExtension(page, "noTracking", false);
    expect(await xhr(page, "POST", `/api/v9/science?c=${channel}`, "{}")).toBe(200);
});

test("clean links strips tracking from sent and edited messages, keeping real parameters", async ({ page }) => {
    await setExtension(page, "socialEmbeds", false);
    const content = "look https://www.youtube.com/watch?v=abc123&si=TRACK&t=42 and (https://shop.example/item?id=7&utm_source=x&fbclid=y). "
        + "https://x.com/user/status/1?s=20&t=abc <https://example.com/?gclid=1> https://example.com/plain?q=1";
    await xhr(page, "POST", `/api/v9/channels/${channel}/messages`, JSON.stringify({ content, nonce: "1" }));
    await xhr(page, "PATCH", `/api/v9/channels/${channel}/messages/5`, JSON.stringify({ content: "https://open.spotify.com/track/1?si=abc" }));
    const [sent, edited] = (await received(page)).map(entry => JSON.parse(entry.body));
    expect(sent).toEqual({ nonce: "1", content: "look https://www.youtube.com/watch?v=abc123&t=42 and (https://shop.example/item?id=7). "
        + "https://x.com/user/status/1 <https://example.com/> https://example.com/plain?q=1" });
    expect(edited.content).toBe("https://open.spotify.com/track/1");
    await setExtension(page, "cleanUrls", false);
    await xhr(page, "POST", `/api/v9/channels/${channel}/messages`, JSON.stringify({ content }));
    expect(JSON.parse((await received(page))[2].body).content).toBe(content);
});

test("anonymised uploads get 7 random letters, keep extension and spoiler, and match the message", async ({ page }) => {
    const files = [{ id: "1", filename: "Screenshot 2026-10-03 at 4.19.04 AM.png" }, { id: "2", filename: "SPOILER_secret.mp4" }, { id: "3", filename: "backup.tar.gz" }];
    await xhr(page, "POST", `/api/v9/channels/${channel}/attachments`, JSON.stringify({ files }));
    await xhr(page, "POST", `/api/v9/channels/${channel}/messages`, JSON.stringify({ content: "", attachments: files.map((file, id) => ({ id: String(id), filename: file.filename, uploaded_filename: "x" })) }));
    const [upload, message] = (await received(page)).map(entry => JSON.parse(entry.body));
    const names = upload.files.map(file => file.filename);
    expect(names[0]).toMatch(/^[a-z]{7}\.png$/);
    expect(names[1]).toMatch(/^SPOILER_[a-z]{7}\.mp4$/);
    expect(names[2]).toMatch(/^[a-z]{7}\.tar\.gz$/);
    expect(message.attachments.map(attachment => attachment.filename)).toEqual(names);
    // The older multipart path renames the File part itself.
    await page.evaluate(path => {
        const form = new FormData();
        form.append("files[0]", new File(["bytes"], "holiday photo.jpg", { type: "image/jpeg" }));
        form.append("payload_json", JSON.stringify({ content: "" }));
        return fetch(path, { method: "POST", body: form });
    }, `/api/v9/channels/${channel}/messages`);
    expect((await received(page))[2].body).toMatch(/filename="[a-z]{7}\.jpg"/);
    await setExtension(page, "anonymiseFileNames", false);
    await xhr(page, "POST", `/api/v9/channels/${channel}/attachments`, JSON.stringify({ files: [files[0]] }));
    expect(JSON.parse((await received(page))[3].body).files[0].filename).toBe(files[0].filename);
});

test("files are anonymised as they reach the composer, before Discord uploads them", async ({ page }) => {
    const seen = await page.evaluate(() => {
        const seen = [];
        const area = document.querySelector(".channelTextArea_test");
        const input = Object.assign(document.createElement("input"), { type: "file", multiple: true });
        area.append(input);
        // Stand-ins for Discord's own handlers, which run after Lowcord's.
        input.addEventListener("change", () => seen.push(["picker", ...[...input.files].map(file => file.name)]));
        area.addEventListener("paste", event => seen.push(["paste", ...[...event.clipboardData.files].map(file => file.name)]));
        area.addEventListener("drop", event => seen.push(["drop", ...[...event.dataTransfer.files].map(file => file.name)]));
        const files = () => { const data = new DataTransfer(); data.items.add(new File(["a"], "My Photo.PNG", { type: "image/png" })); return data; };
        input.files = files().files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        area.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: files() }));
        area.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: files() }));
        // Plain text pastes and drags pass through unchanged.
        const text = new DataTransfer(); text.setData("text/plain", "hello");
        area.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: text }));
        return seen;
    });
    expect(seen.map(([kind]) => kind)).toEqual(["picker", "paste", "drop", "paste"]);
    for (const [, name] of seen.slice(0, 3)) expect(name).toMatch(/^[a-z]{7}\.PNG$/);
    expect(seen[3]).toEqual(["paste"]);
    // The upload request keeps the name Discord already showed, spoilered or not.
    const files = [{ id: "1", filename: seen[0][1] }, { id: "2", filename: `SPOILER_${seen[1][1]}` }];
    await xhr(page, "POST", `/api/v9/channels/${channel}/attachments`, JSON.stringify({ files }));
    expect(JSON.parse((await received(page))[0].body).files).toEqual(files);
});

test("voice message button sits in the message bar and opens the recorder", async ({ page }) => {
    const button = page.getByRole("button", { name: "Record a voice message" });
    await expect(button).toHaveCount(1);
    await expect(page.locator(".buttons_test > :first-child")).toHaveClass(/lowcord-voice-button/);
    await button.click();
    const dialog = page.getByRole("dialog", { name: "Record a voice message" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Send" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await setExtension(page, "voiceMessages", false);
    await expect(button).toHaveCount(0);
    await setExtension(page, "voiceMessages", true);
    await expect(button).toHaveCount(1);
});

// Feed real Web Audio into real MediaRecorder without needing an OS microphone
// or playing sound through speakers. Only getUserMedia is substituted.
async function recordingInput(page, { unavailable = false, pending = false } = {}) {
    await page.evaluate(({ unavailable, pending }) => {
        const NativeAudioContext = window.AudioContext;
        const input = new NativeAudioContext();
        const oscillator = input.createOscillator();
        const gain = input.createGain();
        gain.gain.value = 0;
        oscillator.connect(gain);
        const contexts = [], streams = [];
        window.AudioContext = class extends NativeAudioContext {
            constructor(...args) { super(...args); contexts.push(this); }
            createAnalyser() {
                if (unavailable) throw new Error("No analyser");
                const analyser = super.createAnalyser();
                const read = analyser.getFloatTimeDomainData.bind(analyser);
                analyser.getFloatTimeDomainData = samples => { window.recordingInput.reads++; read(samples); };
                return analyser;
            }
        };
        window.recordingInput = { contexts, streams, reads: 0,
            volume: value => { gain.gain.value = value; } };
        oscillator.start();
        Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => {
            await input.resume();
            const destination = input.createMediaStreamDestination();
            gain.connect(destination);
            streams.push(destination.stream);
            if (pending) await new Promise(resolve => { window.recordingInput.allow = resolve; });
            return destination.stream;
        } });
    }, { unavailable, pending });
    await page.getByRole("button", { name: "Record a voice message" }).click();
    await page.getByRole("button", { name: "Record", exact: true }).click();
}

const newestWaveHeight = page => page.locator(".lowcord-voice-waveform").evaluate(canvas => {
    const { width, height } = canvas;
    const pixels = canvas.getContext("2d").getImageData(width - 20, 0, 15, height).data;
    let top = height, bottom = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < 15; x++) {
            if (pixels[(y * 15 + x) * 4 + 3]) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
        }
    }
    return Math.max(0, bottom - top + 1);
});

test("live recording waveform responds to sound and silence, then releases audio resources", async ({ page }) => {
    await recordingInput(page);
    const visualization = page.locator(".lowcord-voice-visualization");
    const signal = page.locator(".lowcord-voice-signal");
    await expect(visualization).toBeVisible();
    await expect(signal).toHaveText("Listening for sound…");
    await expect.poll(() => newestWaveHeight(page)).toBeLessThan(8);
    await page.evaluate(() => recordingInput.volume(0.04));
    await expect(signal).toHaveText("Microphone is picking up sound");
    await expect.poll(() => newestWaveHeight(page)).toBeGreaterThan(18);
    const quietHeight = await newestWaveHeight(page);
    await page.evaluate(() => recordingInput.volume(0.3));
    await expect.poll(() => newestWaveHeight(page)).toBeGreaterThan(quietHeight + 12);
    await page.screenshot({ path: test.info().outputPath("recording-waveform.png") });
    await page.evaluate(() => recordingInput.volume(0));
    await expect(signal).toHaveText("Listening for sound…");
    await expect.poll(() => newestWaveHeight(page)).toBeLessThan(8);
    // Old sound remains to the left while the newest bars show silence.
    expect(await page.locator(".lowcord-voice-waveform").evaluate(canvas => {
        const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width - 30, 16).data;
        return pixels.some((value, index) => index % 4 === 3 && value > 0);
    })).toBe(true);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(visualization).toBeHidden();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await expect.poll(() => page.evaluate(() => recordingInput.contexts.every(context => context.state === "closed"))).toBe(true);
    expect(await page.evaluate(() => recordingInput.streams.every(stream => stream.getTracks().every(track => track.readyState === "ended")))).toBe(true);
    const reads = await page.evaluate(() => recordingInput.reads);
    // Re-recording gets a fresh waveform and cannot send the earlier recording.
    await page.getByRole("button", { name: "Record again", exact: true }).click();
    await expect(visualization).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await expect(page.locator(".lowcord-voice audio")).toBeHidden();
    await expect.poll(() => page.evaluate(() => recordingInput.reads)).toBeGreaterThan(reads);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator(".lowcord-voice-backdrop")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => recordingInput.contexts.every(context => context.state === "closed"))).toBe(true);
    expect(await page.evaluate(() => recordingInput.streams.every(stream => stream.getTracks().every(track => track.readyState === "ended")))).toBe(true);
});

test("reduced motion recording shows a stationary level meter and Escape stops it", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await recordingInput(page);
    const meter = page.locator(".lowcord-voice-waveform");
    const silence = await meter.evaluate(canvas => canvas.toDataURL());
    await page.evaluate(() => recordingInput.volume(0.2));
    await expect(page.locator(".lowcord-voice-signal")).toHaveText("Microphone is picking up sound");
    await expect.poll(() => meter.evaluate(canvas => canvas.toDataURL())).not.toBe(silence);
    await expect.poll(() => newestWaveHeight(page)).toBeLessThan(8);
    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => recordingInput.contexts.every(context => context.state === "closed"))).toBe(true);
    expect(await page.evaluate(() => recordingInput.streams[0].getTracks()[0].readyState)).toBe("ended");
});

test("an unavailable live analyser does not prevent recording and preview", async ({ page }) => {
    await recordingInput(page, { unavailable: true });
    await expect(page.locator(".lowcord-voice-signal")).toHaveText("Live waveform unavailable. Recording continues.");
    await page.evaluate(() => recordingInput.volume(0.2));
    await expect.poll(() => page.evaluate(() => recordingInput.streams[0].getTracks()[0].readyState)).toBe("live");
    await expect(page.locator(".lowcord-voice-time")).not.toHaveText("0:00");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await expect(page.locator(".lowcord-voice audio")).toBeVisible();
});

test("closing while microphone permission is pending releases the late stream", async ({ page }) => {
    await recordingInput(page, { pending: true });
    await expect.poll(() => page.evaluate(() => typeof recordingInput.allow)).toBe("function");
    await page.keyboard.press("Escape");
    await page.evaluate(() => recordingInput.allow());
    await expect.poll(() => page.evaluate(() => recordingInput.streams[0].getTracks()[0].readyState)).toBe("ended");
    expect(await page.evaluate(() => recordingInput.contexts.length)).toBe(0);
    await expect(page.locator(".lowcord-voice-backdrop")).toHaveCount(0);
});

test("OrbitCord section in Discord's settings opens both pages, and toggles save", async ({ page }) => {
    const section = page.locator(".lowcord-sidebar-section");
    await expect(section).toHaveCount(1);
    // Placed after the first section, reusing Discord's class names.
    await expect(page.locator('ul[role="list"] > li').nth(1)).toHaveClass(/lowcord-sidebar-section/);
    await expect(section.getByText("Chat Appearance")).toBeVisible();
    await expect(section.getByText("Extensions")).toBeVisible();
    await expect(section.locator(".active_test")).toHaveCount(0);
    await section.getByText("Extensions").click();
    const dialog = page.getByRole("dialog", { name: "OrbitCord Settings" });
    await expect(dialog.getByRole("heading", { name: "Extensions" })).toBeVisible();
    const toggles = dialog.getByRole("switch");
    await expect(toggles).toHaveCount(Object.keys(await page.evaluate(() => Lowcord.extensions.state)).length);
    for (const toggle of await toggles.all()) await expect(toggle).toBeChecked();
    await dialog.getByRole("switch", { name: /Silent typing/ }).uncheck();
    expect(await page.evaluate(() => JSON.parse(Lowcord.storage.getItem("lowcord.extensions")).silentTyping)).toBe(false);
    await dialog.getByRole("button", { name: "Chat Appearance" }).click();
    await expect(dialog.getByRole("switch", { name: /Chat bubbles/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.evaluate(() => window.__lowcordOpenSettings("extensions"));
    await expect(dialog.getByRole("switch", { name: /Silent typing/ })).not.toBeChecked();
});
