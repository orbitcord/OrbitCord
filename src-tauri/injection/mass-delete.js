// Mass delete: finds every message the user sent in the open DM, channel or
// whole server through Discord's own search, then deletes them one by one with
// Discord's REST client. Single deletes have no age limit, unlike bulk delete.
// It paces itself below Discord's rate limits and keeps running while the user
// moves around; one job at a time.
(() => {
    const extensions = window.Lowcord.extensions;
    const { ui, toast } = extensions;
    const trashPath = "M14.25 1c.41 0 .75.34.75.75V3h5.25c.41 0 .75.34.75.75v.5c0 .41-.34.75-.75.75H3.75A.75.75 0 0 1 3 4.25v-.5c0-.41.34-.75.75-.75H9V1.75c0-.41.34-.75.75-.75h4.5ZM5.06 7a1 1 0 0 0-1 1.06l.76 12.13a3 3 0 0 0 3 2.81h8.36a3 3 0 0 0 3-2.81l.75-12.13a1 1 0 0 0-1-1.06H5.07ZM11 12a1 1 0 1 0-2 0v6a1 1 0 1 0 2 0v-6Zm3-1a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1Z";
    // Deletes go as fast as Discord allows: each channel has its own delete
    // limit, read from the rate-limit headers of every response, and up to
    // `lanes` channels delete at once. Without headers, a channel slows down
    // after a 429 and speeds back up. The next search page loads while the
    // current one is deleted. Milliseconds.
    const pacing = { lanes: 4, gapCeiling: 15_000, search: 250, indexing: 3000 };
    // Errors that mean "leave this one": unknown message, missing access or
    // permissions, a system message, an archived thread.
    const skipCodes = new Set([10008, 50001, 50013, 50021, 50083]);

    const store = name => window.Lowcord.store(name);
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    let job;

    // ----- Scope --------------------------------------------------------------
    function userName(id) {
        const user = store("UserStore")?.getUser?.(id);
        return user?.globalName || user?.global_name || user?.username || "this person";
    }
    function currentTarget() {
        const channelId = store("SelectedChannelStore")?.getChannelId?.();
        const channel = channelId && store("ChannelStore")?.getChannel?.(channelId);
        if (!channel) return null;
        const guildId = channel.guild_id ?? channel.getGuildId?.() ?? null;
        if (!guildId) {
            const recipients = channel.recipients ?? [];
            const name = channel.name || (recipients.length === 1 ? userName(recipients[0]) : "this group");
            return { channelId, guildId: null, channelName: name };
        }
        // A thread is searched on its own; the server choice covers every thread.
        return { channelId, guildId, channelName: `#${channel.name}`, guildName: store("GuildStore")?.getGuild?.(guildId)?.name || "this server" };
    }

    // ----- Requests -----------------------------------------------------------
    // Discord's client rejects with the response; a 429 carries retry_after.
    const bodyOf = error => error?.body ?? {};
    const retryAfter = error => Math.max(1000, (Number(bodyOf(error).retry_after) || 2) * 1000);
    function idBefore(id) { return (BigInt(id) - 1n).toString(); }

    async function searchPage(current, maxId) {
        const { target, me } = current;
        const url = target.guildId ? `/guilds/${target.guildId}/messages/search` : `/channels/${target.channelId}/messages/search`;
        const query = { author_id: me, sort_by: "timestamp", sort_order: "desc", include_nsfw: true };
        if (target.guildId && current.scope === "channel") query.channel_id = target.channelId;
        if (maxId) query.max_id = maxId;
        for (let attempt = 0; ; attempt++) {
            if (current.stopped) return null;
            let response;
            try { response = await window.Lowcord.RestAPI.get({ url, query, retries: 0 }); }
            catch (error) {
                if (error?.status === 429) { await wait(retryAfter(error)); continue; }
                if (attempt < 3) { await wait(pacing.search * (attempt + 2)); continue; }
                throw error;
            }
            // 202: Discord is still indexing this channel or server.
            if (response?.status === 202) {
                current.indexing = true; render();
                await wait(Math.max(pacing.indexing, (Number(response.body?.retry_after) || 0) * 1000));
                continue;
            }
            current.indexing = false;
            return response?.body ?? {};
        }
    }

    function header(response, name) {
        const headers = response?.headers;
        const value = typeof headers?.get === "function" ? headers.get(name) : headers?.[name];
        return value == null ? null : Number(value);
    }
    // A channel's lane: when it may next delete, and its fallback gap.
    function laneOf(current, channelId) {
        let lane = current.lanes.get(channelId);
        if (!lane) current.lanes.set(channelId, lane = { readyAt: 0, gap: 0 });
        return lane;
    }
    async function ready(current, lane) {
        for (;;) {
            const until = Math.max(lane.readyAt, current.pausedUntil) - performance.now();
            if (until <= 0 || current.stopped) return;
            await wait(until);
        }
    }
    // true when gone, false when it can't be deleted, null when stopped.
    async function remove(current, message) {
        const lane = laneOf(current, message.channel_id);
        for (let attempt = 0; ; attempt++) {
            await ready(current, lane);
            if (current.stopped) return null;
            try {
                const response = await window.Lowcord.RestAPI.del({ url: `/channels/${message.channel_id}/messages/${message.id}`, retries: 0 });
                const remaining = header(response, "x-ratelimit-remaining"), resetAfter = header(response, "x-ratelimit-reset-after");
                if (remaining !== null && resetAfter !== null) {
                    lane.gap = 0;
                    if (remaining <= 0) lane.readyAt = performance.now() + resetAfter * 1000;
                } else {
                    lane.gap = lane.gap > 50 ? lane.gap * 0.9 : 0;
                    lane.readyAt = performance.now() + lane.gap;
                }
                return true;
            } catch (error) {
                if (error?.status === 429) {
                    const until = performance.now() + retryAfter(error);
                    if (bodyOf(error).global) current.pausedUntil = until;
                    lane.gap = Math.min(pacing.gapCeiling, Math.max(250, lane.gap * 1.5));
                    lane.readyAt = Math.max(until, performance.now() + lane.gap);
                    continue;
                }
                if (error?.status === 404) return true;
                if (skipCodes.has(bodyOf(error).code) || error?.status === 403) return false;
                if (attempt < 2) { await wait(500 * (attempt + 1)); continue; }
                throw error;
            }
        }
    }

    // Deletes one channel's messages of a page, oldest last.
    async function deleteAll(current, messages) {
        for (const message of messages) {
            if (current.stopped) return;
            let gone;
            try { gone = await remove(current, message); current.failures = 0; }
            catch (error) {
                console.warn("[lowcord] Mass delete:", error);
                if (++current.failures >= 5) throw error;
                gone = false;
            }
            if (gone === null) return;
            if (gone) current.deleted++; else current.skipped++;
            if (current.remaining > 0) current.remaining--;
            render();
        }
    }

    async function run(current) {
        const seen = new Set();
        let maxId, pending = searchPage(current);
        while (!current.stopped) {
            const body = await pending;
            if (!body) break;
            if (Number.isFinite(body.total_results)) current.remaining = body.total_results;
            // Each result is a list: the hit and, on older API versions, context.
            const page = (body.messages ?? []).flat()
                .filter(message => message?.author?.id === current.me && message.id)
                .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
            if (!page.length) break;
            const fresh = page.filter(message => !seen.has(message.id));
            // max_id moves past the oldest result, so a message search keeps
            // returning after it was deleted, or one that can't be, is passed.
            const next = idBefore(page[page.length - 1].id);
            if (!fresh.length && next === maxId) break;
            maxId = next;
            pending = wait(pacing.search).then(() => searchPage(current, next));
            pending.catch(() => {}); // Awaited below; this only marks it handled.
            for (const message of fresh) seen.add(message.id);
            const byChannel = new Map();
            for (const message of fresh) {
                if (!byChannel.has(message.channel_id)) byChannel.set(message.channel_id, []);
                byChannel.get(message.channel_id).push(message);
            }
            const queue = [...byChannel.values()];
            await Promise.all(Array.from({ length: Math.min(pacing.lanes, queue.length) }, async () => {
                while (queue.length && !current.stopped) await deleteAll(current, queue.shift());
            }));
        }
    }

    // ----- Status bar ---------------------------------------------------------
    function render() {
        if (!job) return;
        const { bar, deleted, skipped, remaining, indexing, stopped, scopeLabel } = job;
        bar.title.textContent = stopped ? "Stopping…" : indexing && !deleted ? "Discord is preparing search…"
            : `Deleting your messages… ${deleted.toLocaleString()}`;
        const left = remaining > 0 ? `About ${remaining.toLocaleString()} left` : "Looking for more";
        bar.detail.textContent = [scopeLabel, left, skipped ? `${skipped.toLocaleString()} can’t be deleted` : ""].filter(Boolean).join(" · ");
    }
    async function start(target, scope) {
        if (job) return job.promise;
        const me = store("UserStore")?.getCurrentUser?.()?.id;
        if (!me || !window.Lowcord.RestAPI) { toast("Couldn’t start deleting. Please try again in a moment.", true); return; }
        const title = ui("span", { className: "lowcord-toast-title" });
        const detail = ui("span", { className: "lowcord-toast-detail", "aria-live": "polite" });
        const stopButton = ui("button", { type: "button", className: "lowcord-button", onClick: stop }, "Stop");
        const node = ui("div", { className: "lowcord-purge-bar", role: "status", "aria-label": "Deleting your messages" },
            ui("span", { className: "lowcord-toast-copy" }, title, detail), stopButton);
        const scopeLabel = scope === "server" ? target.guildName : target.channelName;
        const current = job = { target, scope, me, scopeLabel, deleted: 0, skipped: 0, remaining: 0, lanes: new Map(), pausedUntil: 0, failures: 0,
            stopped: false, indexing: false, bar: { node, title, detail } };
        document.body.append(node);
        render();
        current.promise = (async () => {
            let failure;
            try { await run(current); } catch (error) { failure = error; }
            node.remove();
            if (job === current) job = undefined;
            const count = `${current.deleted.toLocaleString()} message${current.deleted === 1 ? "" : "s"}`;
            if (failure) toast(`Deleting stopped after ${count} because Discord didn’t respond. Try again later to continue.`, true);
            else if (current.stopped) toast(`Stopped after deleting ${count}.`);
            else if (current.skipped) toast(`Deleted ${count}. ${current.skipped.toLocaleString()} couldn’t be deleted, such as system messages or archived threads.`);
            else toast(current.deleted ? `Deleted ${count}.` : `No messages of yours were found in ${scopeLabel}.`);
            return { deleted: current.deleted, skipped: current.skipped, stopped: current.stopped, failed: Boolean(failure) };
        })();
        return current.promise;
    }
    function stop() {
        if (!job || job.stopped) return;
        job.stopped = true;
        render();
    }

    // ----- Confirmation -------------------------------------------------------
    function confirm() {
        if (job) { toast("Already deleting messages. Stop that first to start another.", true); return; }
        if (document.querySelector(".lowcord-purge-backdrop")) return;
        const target = currentTarget();
        if (!target) { toast("Open a DM or channel first", true); return; }
        let scope = "channel";
        const option = (value, label, hint) => ui("label", { className: "lowcord-purge-option" },
            ui("input", { type: "radio", name: "lowcord-purge-scope", value, onChange: () => { scope = value; } }),
            ui("span", {}, ui("strong", {}, label), ui("span", {}, hint)));
        const options = target.guildId && ui("div", { className: "lowcord-purge-options", role: "radiogroup", "aria-label": "Where to delete" },
            option("channel", `Only in ${target.channelName}`, "Its threads aren’t included."),
            option("server", `Everywhere in ${target.guildName}`, "Every channel and thread you can still open."));
        options?.querySelector("input").setAttribute("checked", "");
        const lead = target.guildId ? "Every message you sent will be deleted, however old."
            : `Every message you sent to ${target.channelName} will be deleted, however old. Their messages stay.`;
        const confirmButton = ui("button", { type: "button", className: "lowcord-button lowcord-button-danger", onClick: () => {
            close(); start(target, scope);
        } }, "Delete my messages");
        const cancel = ui("button", { type: "button", className: "lowcord-button", onClick: () => close() }, "Cancel");
        const dialog = ui("div", { className: "lowcord-voice lowcord-purge", role: "dialog", "aria-modal": "true", "aria-labelledby": "lowcord-purge-title" },
            ui("h2", { id: "lowcord-purge-title" }, "Delete your messages?"),
            ui("p", { className: "lowcord-voice-status" }, lead),
            options,
            ui("p", { className: "lowcord-voice-status" }, "This can’t be undone. It deletes as fast as Discord allows, so a long history can still take a while. You can keep using Discord meanwhile."),
            ui("div", { className: "lowcord-dialog-actions" }, cancel, confirmButton));
        const backdrop = ui("div", { className: "lowcord-voice-backdrop lowcord-purge-backdrop", onMousedown: event => { if (event.target === backdrop) close(); } }, dialog);
        const onKey = event => { if (event.key === "Escape") { event.stopPropagation(); close(); } };
        function close() { window.removeEventListener("keydown", onKey, true); backdrop.remove(); }
        window.addEventListener("keydown", onKey, true);
        document.body.append(backdrop);
        cancel.focus();
    }

    // ----- Message bar action ---------------------------------------------------
    extensions.addComposerAction({ id: "massDelete", order: 2, label: "Delete my messages", path: trashPath, danger: true, run: confirm });
    window.Lowcord.massDelete = { confirm, start, stop, pacing, get active() { return Boolean(job); } };
})();
