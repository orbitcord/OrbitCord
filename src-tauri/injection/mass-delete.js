// Mass delete: finds every message the user sent in the open DM, channel or
// whole server through Discord's search and channel history, then deletes them with
// Discord's REST client. Single deletes have no age limit, unlike bulk delete.
// It paces itself below Discord's rate limits and keeps running while the user
// moves around; one job at a time.
(() => {
    const extensions = window.Lowcord.extensions;
    const { ui, toast } = extensions;
    const trashPath = "M14.25 1c.41 0 .75.34.75.75V3h5.25c.41 0 .75.34.75.75v.5c0 .41-.34.75-.75.75H3.75A.75.75 0 0 1 3 4.25v-.5c0-.41.34-.75.75-.75H9V1.75c0-.41.34-.75.75-.75h4.5ZM5.06 7a1 1 0 0 0-1 1.06l.76 12.13a3 3 0 0 0 3 2.81h8.36a3 3 0 0 0 3-2.81l.75-12.13a1 1 0 0 0-1-1.06H5.07ZM11 12a1 1 0 1 0-2 0v6a1 1 0 1 0 2 0v-6Zm3-1a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1Z";
    // Deletes go as fast as Discord allows: each channel has its own delete
    // limit, read from the rate-limit headers of every response, and up to
    // `lanes` server channels delete at once. DMs can overlap a few requests
    // within a reported quota. Without headers, a channel stays sequential
    // and backs off on a 429. Search reads ahead of deletion. Milliseconds.
    const pacing = { lanes: 4, dmConcurrency: 3, lookahead: 100, gapCeiling: 15_000, search: 250, indexing: 3000 };
    // Errors that mean "leave this one": unknown message, missing access or
    // permissions, a system message, an archived thread.
    const skipCodes = new Set([10008, 50001, 50013, 50021, 50083]);

    const store = name => window.Lowcord.store(name);
    const wait = (current, ms) => new Promise(resolve => {
        if (current.stopped) { resolve(); return; }
        const resume = () => { clearTimeout(timer); current.waiters.delete(resume); resolve(); };
        const timer = setTimeout(resume, ms);
        current.waiters.add(resume);
    });
    let job;
    // Successful full history checks only, scoped to account/channel and this
    // app session. No message content is retained. Reaction jobs bypass these
    // because a user can add a reaction to an arbitrarily old message.
    const verifiedHistory = new Map();
    const historyKey = (current, channelId) => `${current.me}:${channelId}`;

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
    const retryAfter = error => {
        const supplied = bodyOf(error).retry_after ?? header(error, "retry-after");
        const seconds = supplied == null ? NaN : Number(supplied);
        // Discord returns fractional seconds. Only use a default if no valid
        // delay was supplied; a small floor avoids spinning on a zero delay.
        return Math.max(50, Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2000);
    };
    function pause(current, error) {
        const delay = retryAfter(error);
        if (bodyOf(error).global) current.pausedUntil = Math.max(current.pausedUntil, performance.now() + delay);
        return delay;
    }
    function idBefore(id) { return (BigInt(id) - 1n).toString(); }

    async function searchPage(current, maxId) {
        const { target, me } = current;
        const url = target.guildId ? `/guilds/${target.guildId}/messages/search` : `/channels/${target.channelId}/messages/search`;
        const query = { author_id: me, sort_by: "timestamp", sort_order: "desc", include_nsfw: true };
        if (target.guildId && current.scope === "channel") query.channel_id = target.channelId;
        if (maxId) query.max_id = maxId;
        for (let attempt = 0; ; attempt++) {
            await ready(current, { readyAt: 0 });
            if (current.stopped) return null;
            let response;
            try { response = await window.Lowcord.RestAPI.get({ url, query, retries: 0 }); }
            catch (error) {
                if (error?.status === 429) { await wait(current, pause(current, error)); continue; }
                if (attempt < 3) { await wait(current, pacing.search * (attempt + 2)); continue; }
                throw error;
            }
            // 202: Discord is still indexing this channel or server.
            if (response?.status === 202) {
                current.indexing = true; render();
                const seconds = Number(response.body?.retry_after);
                await wait(current, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : pacing.indexing);
                continue;
            }
            current.indexing = false;
            return response?.body ?? {};
        }
    }

    // History is authoritative for messages that haven't reached search yet.
    // Use the same REST client and back off on rate limits, including global ones.
    async function historyRequest(current, url, query) {
        const lane = laneOf(current, `history:${url}`);
        for (let attempt = 0; ; attempt++) {
            await ready(current, lane);
            if (current.stopped) return null;
            try {
                const response = await window.Lowcord.RestAPI.get({ url, query, retries: 0 });
                const remaining = header(response, "x-ratelimit-remaining"), reset = header(response, "x-ratelimit-reset-after");
                // Read at Discord's reported quota instead of adding a fixed
                // delay to every history page. Unknown quotas retain pacing.
                lane.readyAt = performance.now() + (remaining !== null && reset !== null
                    ? remaining <= 0 ? reset * 1000 : 0 : pacing.search);
                return response.body;
            } catch (error) {
                if (error?.status === 429) {
                    await wait(current, pause(current, error));
                    continue;
                }
                if (error?.status === 403 || error?.status === 404) {
                    current.unchecked++;
                    return null;
                }
                if (attempt < 3) { await wait(current, pacing.search * (attempt + 2)); continue; }
                throw error;
            }
        }
    }

    // Don't finish a job while another channel still has requests in flight.
    async function inParallel(queue, work) {
        const results = await Promise.allSettled(Array.from({ length: Math.min(pacing.lanes, queue.length) }, work));
        const failure = results.find(result => result.status === "rejected");
        if (failure) throw failure.reason;
    }

    async function recentHistory(current, newest, seen) {
        current.phase = "history";
        current.remaining = 0;
        render();
        const channels = new Set([current.target.channelId, ...newest.keys()]);
        if (current.scope === "server") {
            const guild = current.target.guildId;
            const listed = await historyRequest(current, `/guilds/${guild}/channels`);
            const active = await historyRequest(current, `/guilds/${guild}/threads/active`);
            if (current.stopped) return;
            for (const channel of [...(listed ?? []), ...(active?.threads ?? [])]) {
                // Categories, forums and media containers have no message history.
                if ([0, 2, 5, 10, 11, 12, 13].includes(channel.type)) channels.add(channel.id);
            }
        }
        current.remaining = 0;
        const queue = [...channels];
        current.historyTotal = queue.length;
        render();
        await inParallel(queue, async () => {
            while (queue.length && !current.stopped) {
                const channelId = queue.shift(), key = historyKey(current, channelId);
                const checkpoint = verifiedHistory.get(key);
                const boundary = current.reactions ? null : checkpoint ?? newest.get(channelId);
                let before = current.before, checked = true, hadMessages = false;
                while (!current.stopped) {
                    const page = await historyRequest(current, `/channels/${channelId}/messages`, { limit: 100, before });
                    if (page === null || current.stopped) { checked = false; break; }
                    if (!Array.isArray(page)) throw new Error("Unexpected channel history response");
                    if (!page.length) break;
                    hadMessages = true;
                    current.historyScanned += page.length;
                    render();
                    if (current.reactions) {
                        current.scanningReactions = true;
                        render();
                        await removeReactions(current, page.filter(message => BigInt(message.id) < BigInt(current.before)));
                    }
                    const fresh = page.filter(message => message.author?.id === current.me
                        && BigInt(message.id) < BigInt(current.before)
                        && (!boundary || BigInt(message.id) > BigInt(boundary)) && !seen.has(message.id));
                    for (const message of fresh) seen.add(message.id);
                    await deleteAll(current, fresh);
                    const oldest = page.reduce((id, message) => BigInt(message.id) < BigInt(id) ? message.id : id, page[0].id);
                    // The indexed history is already handled. With no search hits,
                    // walk to the end, including when search was entirely empty.
                    if (page.length < 100 || (boundary && BigInt(oldest) <= BigInt(boundary))) break;
                    if (before && BigInt(oldest) >= BigInt(before)) throw new Error("Channel history did not advance");
                    before = oldest;
                }
                // A search boundary only proves the recent tail was checked.
                // Cache only full walks (or a walk back to a previous full check).
                if (checked && hadMessages && !current.stopped && !current.failedChannels.has(channelId)
                    && (!boundary || checkpoint) && !current.reactions) {
                    verifiedHistory.delete(key);
                    verifiedHistory.set(key, idBefore(current.before));
                    if (verifiedHistory.size > 1000) verifiedHistory.delete(verifiedHistory.keys().next().value);
                }
                if (checked && !current.stopped) current.historyDone++;
                render();
            }
        });
    }

    function header(response, name) {
        const headers = response?.headers;
        const value = typeof headers?.get === "function" ? headers.get(name)
            : headers?.[name] ?? Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
        if (value == null || value === "") return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }
    // A channel's cooldown, fallback gap, and last reported available quota.
    function laneOf(current, channelId) {
        let lane = current.lanes.get(channelId);
        if (!lane) current.lanes.set(channelId, lane = { readyAt: 0, gap: 0, remaining: null, serialOnly: false });
        return lane;
    }
    async function ready(current, lane) {
        for (;;) {
            const until = Math.max(lane.readyAt, current.pausedUntil) - performance.now();
            // Never use another account's session to continue this job.
            if (store("UserStore")?.getCurrentUser?.()?.id !== current.me) current.stopped = true;
            if (until <= 0 || current.stopped) return;
            await wait(current, until);
        }
    }
    // true when gone, false when it can't be deleted, null when stopped.
    async function remove(current, message, reactionUrl) {
        const lane = laneOf(current, message.channel_id);
        for (let attempt = 0; ; attempt++) {
            await ready(current, lane);
            if (current.stopped) return null;
            try {
                const response = await window.Lowcord.RestAPI.del({ url: reactionUrl ?? `/channels/${message.channel_id}/messages/${message.id}`, retries: 0 });
                const remaining = header(response, "x-ratelimit-remaining"), resetAfter = header(response, "x-ratelimit-reset-after");
                if (remaining !== null && resetAfter !== null) {
                    lane.gap = 0;
                    // A round waits for every response before spending more
                    // quota. Use its smallest count, regardless of arrival order.
                    lane.remaining = lane.remaining === null ? remaining : Math.min(lane.remaining, remaining);
                    if (remaining <= 0) lane.readyAt = Math.max(lane.readyAt, performance.now() + resetAfter * 1000);
                } else {
                    lane.serialOnly = true;
                    lane.gap = lane.gap > 50 ? lane.gap * 0.9 : 0;
                    lane.readyAt = performance.now() + lane.gap;
                }
                return true;
            } catch (error) {
                lane.serialOnly = true;
                if (error?.status === 429) {
                    const until = performance.now() + pause(current, error);
                    lane.gap = Math.min(pacing.gapCeiling, Math.max(250, lane.gap * 1.5));
                    lane.readyAt = Math.max(lane.readyAt, until);
                    continue;
                }
                if (error?.status === 404) return true;
                if (skipCodes.has(bodyOf(error).code) || error?.status === 403) return false;
                if (attempt < 2) { await wait(current, 500 * (attempt + 1)); continue; }
                throw error;
            }
        }
    }

    async function deleteOne(current, message, reactionUrl) {
        if (current.stopped) return;
        let gone;
        try { gone = await remove(current, message, reactionUrl); current.failures = 0; }
        catch (error) {
            console.warn("[lowcord] Bulk delete:", error);
            if (++current.failures >= 5) throw error;
            gone = false;
        }
        if (gone === null) return;
        if (!gone) {
            current.failedChannels.add(message.channel_id);
            verifiedHistory.delete(historyKey(current, message.channel_id));
        }
        if (reactionUrl) {
            if (gone) current.reactionsRemoved++; else current.reactionsSkipped++;
        } else {
            if (gone) current.deleted++; else current.skipped++;
            if (current.remaining > 0) current.remaining--;
        }
        render();
    }

    async function removeReactions(current, messages) {
        for (const message of messages) {
            for (const reaction of message.reactions ?? []) {
                if (current.stopped) return;
                // Discord's documented own-reaction endpoint handles standard
                // reactions. Never claim unsupported super reactions were removed.
                if (reaction.me_burst) current.reactionsSkipped++;
                if (!reaction.me) continue;
                const emoji = reaction.emoji;
                if (!emoji?.name) { current.reactionsSkipped++; continue; }
                const encoded = encodeURIComponent(emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name);
                await deleteOne(current, message, `/channels/${message.channel_id}/messages/${message.id}/reactions/${encoded}/@me`);
            }
        }
        render();
    }

    // Large DMs can spend a known quota without waiting for each network
    // round trip. Unknown quotas, errors, and server channels stay sequential.
    async function deleteAll(current, messages) {
        if (!messages.length) return;
        const lane = laneOf(current, messages[0].channel_id);
        const dm = !current.target.guildId && current.scope === "channel";
        for (let offset = 0; offset < messages.length;) {
            await ready(current, lane);
            if (current.stopped) return;
            const count = dm && !lane.serialOnly && lane.remaining >= 1
                ? Math.min(pacing.dmConcurrency, Math.floor(lane.remaining)) : 1;
            const batch = messages.slice(offset, offset + count);
            offset += batch.length;
            lane.remaining = null;
            const results = await Promise.allSettled(batch.map(message => deleteOne(current, message)));
            const failure = results.find(result => result.status === "rejected");
            if (failure) throw failure.reason;
        }
    }

    // Keep a bounded lookahead across search pages. Each channel still has
    // one worker, but a slow channel no longer holds up every later page.
    function deletionQueue(current) {
        const queues = new Map(), running = new Map();
        let buffered = 0, failure;
        const pump = () => {
            if (current.stopped || failure) return;
            for (const [channel, messages] of queues) {
                if (running.size >= pacing.lanes) break;
                if (running.has(channel)) continue;
                const batch = messages.splice(0, 25);
                const work = (async () => {
                    try { await deleteAll(current, batch); }
                    catch (error) { failure ??= error; }
                    finally {
                        buffered -= batch.length;
                        running.delete(channel);
                        queues.delete(channel);
                        if (messages.length) queues.set(channel, messages);
                        pump();
                    }
                })();
                running.set(channel, work);
            }
        };
        return {
            async add(messages) {
                while (!current.stopped && !failure && buffered && buffered + messages.length > pacing.lookahead) {
                    await Promise.race(running.values());
                }
                if (failure) throw failure;
                if (current.stopped) return;
                for (const message of messages) {
                    if (!queues.has(message.channel_id)) queues.set(message.channel_id, []);
                    queues.get(message.channel_id).push(message);
                }
                buffered += messages.length;
                pump();
            },
            async finish(error) {
                failure ??= error;
                while (running.size) await Promise.all(running.values());
                if (failure) throw failure;
            },
        };
    }

    async function run(current) {
        const seen = new Set(), newest = new Map(), deletions = deletionQueue(current);
        let maxId = current.before, failure;
        try {
            while (!current.stopped) {
                const body = await searchPage(current, maxId);
                if (!body) break;
                if (Number.isFinite(body.total_results)) current.remaining = body.total_results;
                render();
                // Each result is a list: the hit and, on older API versions, context.
                const page = (body.messages ?? []).flat()
                    .filter(message => message?.author?.id === current.me && message.id)
                    .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
                if (!page.length) break;
                for (const message of page) {
                    if (!newest.has(message.channel_id)) newest.set(message.channel_id, message.id);
                }
                const fresh = page.filter(message => !seen.has(message.id));
                // Search may still return a deleted message. Move the cursor
                // past it, and never queue the same message twice.
                const next = idBefore(page[page.length - 1].id);
                if (BigInt(next) >= BigInt(maxId)) throw new Error("Message search did not advance");
                maxId = next;
                await deletions.add(fresh);
                for (const message of fresh) seen.add(message.id);
                await wait(current, pacing.search);
            }
        } catch (error) { failure = error; }
        // All requests must settle before completion, Stop, or a failure notice.
        await deletions.finish(failure);
        if (!current.stopped) await recentHistory(current, newest, seen);
    }

    // ----- Status bar ---------------------------------------------------------
    function render() {
        if (!job) return;
        const { bar, deleted, skipped, remaining, indexing, stopped } = job;
        const reactions = job.reactions && `${job.reactionsRemoved.toLocaleString()} reaction${job.reactionsRemoved === 1 ? "" : "s"}`;
        bar.count.textContent = bar.count.title = [stopped && "Stopping…", `${deleted.toLocaleString()} deleted`, reactions, skipped ? `${skipped.toLocaleString()} could not be deleted` : ""].filter(Boolean).join(" · ");
        const phase = indexing ? "Preparing search…" : job.scanningReactions ? "Removing reactions…"
            : job.phase === "history" ? "Checking message history" : "Searching messages…";
        const detail = job.phase === "history"
            ? `${job.historyDone} of ${job.historyTotal} chats checked · ${job.historyScanned.toLocaleString()} messages scanned`
            : remaining > 0 ? `About ${remaining.toLocaleString()} messages left` : "";
        bar.detail.textContent = bar.detail.title = [job.scopeText, phase, detail].filter(Boolean).join(" · ");
        bar.stopButton.disabled = stopped;
    }
    async function start(target, scope, options = {}) {
        if (job) return job.promise;
        const me = store("UserStore")?.getCurrentUser?.()?.id;
        if (!me || !window.Lowcord.RestAPI) { toast("Couldn't start deleting. Try again in a moment.", true); return; }
        const count = ui("span", { className: "lowcord-toast-title lowcord-purge-count" });
        const detail = ui("span", { className: "lowcord-toast-detail" });
        const stopButton = ui("button", { type: "button", className: "lowcord-toast-action", onClick: stop }, "Stop");
        const scopeLabel = scope === "server" ? target.guildName : target.channelName;
        const node = ui("div", { className: "lowcord-purge-bar", role: "status", "aria-label": options.reactions ? "Deleting your messages and removing your reactions" : "Deleting your messages" },
            extensions.toastBadge("progress"), ui("span", { className: "lowcord-toast-copy" }, count, ui("span", { className: "lowcord-purge-more" }, detail)),
            ui("span", { className: "lowcord-purge-stop" }, ui("div", {}, stopButton)));
        const current = job = { target, scope, me, scopeLabel, scopeText: scope === "server" ? `${scopeLabel} · All channels` : scopeLabel, reactions: options.reactions === true, reactionsRemoved: 0, reactionsSkipped: 0, deleted: 0, skipped: 0, remaining: 0, phase: "search", historyTotal: 0, historyDone: 0, historyScanned: 0, failedChannels: new Set(), lanes: new Map(), pausedUntil: 0, failures: 0, unchecked: 0, waiters: new Set(),
            // A fixed upper bound keeps messages sent during the job out of it.
            before: ((BigInt(Date.now()) - 1420070400000n) << 22n).toString(),
            stopped: false, indexing: false, bar: { node, count, detail, stopButton } };
        extensions.mountComposerPopup(node);
        render();
        current.promise = (async () => {
            let failure;
            try { await run(current); } catch (error) { failure = error; }
            node.remove();
            if (job === current) job = undefined;
            const count = `${current.deleted.toLocaleString()} message${current.deleted === 1 ? "" : "s"}`;
            if (current.reactions) {
                const summary = `Deleted ${count} and removed ${current.reactionsRemoved.toLocaleString()} reaction${current.reactionsRemoved === 1 ? "" : "s"}.`;
                const problem = failure ? " Discord did not respond; try again later."
                    : current.stopped ? " Cleanup stopped." : current.unchecked ? " Some channel histories could not be checked." : "";
                const skipped = current.skipped + current.reactionsSkipped;
                toast(summary + problem + (skipped ? ` ${skipped.toLocaleString()} messages or reactions could not be removed.` : ""), Boolean(failure || current.unchecked));
            } else if (failure) toast(`Deleting stopped after ${count} because Discord did not respond. Try again later to continue.`, true);
            else if (current.stopped) toast(`Stopped after deleting ${count}.`);
            else if (current.unchecked) toast(`Deleted ${count}. Some channel histories could not be checked. Try again later to continue.`, true);
            else if (current.skipped) toast(`Deleted ${count}. ${current.skipped.toLocaleString()} could not be deleted, such as system messages or archived threads.`);
            else toast(current.deleted ? `Deleted ${count}.` : `No messages from you were found in ${scopeLabel}.`);
            return { deleted: current.deleted, skipped: current.skipped, reactionsRemoved: current.reactionsRemoved, reactionsSkipped: current.reactionsSkipped, stopped: current.stopped, failed: Boolean(failure), incomplete: current.unchecked > 0 };
        })();
        return current.promise;
    }
    function stop() {
        if (!job || job.stopped) return;
        job.stopped = true;
        for (const resume of job.waiters) resume();
        render();
    }

    // ----- Confirmation -------------------------------------------------------
    function confirm() {
        if (job) { toast("A deletion is already running. Stop it before starting another.", true); return; }
        if (document.querySelector(".lowcord-purge-backdrop")) return;
        const target = currentTarget();
        if (!target) { toast("Open a DM or channel first", true); return; }
        let scope = "channel";
        const option = (value, label, hint) => ui("label", { className: "lowcord-purge-option" },
            ui("input", { type: "radio", name: "lowcord-purge-scope", value, onChange: () => { scope = value; } }),
            ui("span", {}, ui("strong", {}, label), ui("span", {}, hint)));
        const options = target.guildId && ui("div", { className: "lowcord-purge-options", role: "radiogroup", "aria-label": "Delete from" },
            option("channel", target.channelName, "This channel, not its threads"),
            option("server", `All of ${target.guildName}`, "Channels and threads you can open"));
        options?.querySelector("input").setAttribute("checked", "");
        // The caveats only apply once reactions are part of the job.
        const reactionNote = ui("p", { id: "lowcord-purge-reaction-note", className: "lowcord-purge-note", hidden: true }, "Takes longer. Archived threads may be missed. Super reactions stay.");
        const reactions = ui("input", { type: "checkbox", "aria-describedby": "lowcord-purge-reaction-note", onChange: () => { reactionNote.hidden = !reactions.checked; } });
        const confirmButton = ui("button", { type: "button", className: "lowcord-button lowcord-button-danger", onClick: () => {
            close(); start(target, scope, { reactions: reactions.checked });
        } }, "Delete");
        const cancel = ui("button", { type: "button", className: "lowcord-button", onClick: () => close() }, "Cancel");
        const dialog = ui("div", { className: "lowcord-voice lowcord-purge", role: "dialog", "aria-modal": "true", "aria-labelledby": "lowcord-purge-title" },
            ui("h2", { id: "lowcord-purge-title" }, "Delete your messages?"),
            options || ui("p", { className: "lowcord-voice-status" }, `Delete your messages in ${target.channelName}. Other people's messages stay.`),
            ui("div", { className: "lowcord-purge-reactions" },
                ui("label", {}, reactions, "Also remove my reactions"), reactionNote),
            ui("div", { className: "lowcord-dialog-actions" }, cancel, confirmButton));
        const backdrop = ui("div", { className: "lowcord-voice-backdrop lowcord-purge-backdrop", onMousedown: event => { if (event.target === backdrop) close(); } }, dialog);
        const previousFocus = document.activeElement;
        const onKey = event => {
            if (event.key === "Escape") { event.stopPropagation(); close(); }
            if (event.key === "Tab") {
                const controls = [...dialog.querySelectorAll('input, button')].filter(node => node.type !== "radio" || node.checked);
                const index = controls.indexOf(document.activeElement);
                if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1).focus(); }
                else if (!event.shiftKey && index === controls.length - 1) { event.preventDefault(); controls[0].focus(); }
            }
        };
        function close() { window.removeEventListener("keydown", onKey, true); backdrop.remove(); if (previousFocus?.isConnected) previousFocus.focus(); }
        window.addEventListener("keydown", onKey, true);
        document.body.append(backdrop);
        cancel.focus();
    }

    // ----- Message bar action ---------------------------------------------------
    extensions.addComposerAction({ id: "massDelete", order: 2, label: "Delete my messages", path: trashPath, danger: true, run: confirm });
    window.Lowcord.massDelete = { confirm, start, stop, pacing, get active() { return Boolean(job); } };
})();
