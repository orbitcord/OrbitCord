// More quick reactions: Discord's message right-click menu shows at most four
// frequently used reactions. This fills that row up to `total`, wrapping onto
// a second line, from the same frequency list and with the same checks for
// emojis the account can't react with. Discord's code is not changed: the
// extra buttons are copies of Discord's own and react through its own action.
// Nothing runs until a message menu opens.
(() => {
    const { extensions } = window.Lowcord;
    const { enabled, changeEvent } = extensions;
    const ID = "moreQuickReactions", total = 8, extraClass = "lowcord-quick-reaction";
    const store = name => window.Lowcord.store(name);
    const { find, filters } = window.Lowcord;
    let helpers, addReaction, reactionIntention;
    const emojiHelpers = () => helpers ??= find(filters.byProps("getEmojiUnavailableReason", "isEmojiPremiumLocked"));
    const reactionAction = () => addReaction ??= find(filters.byCode("userHasReactedWithEmoji", "MESSAGE_REACTION_ADD"));
    const intention = () => reactionIntention ??= find(value => typeof value?.isExternalEmojiAllowedForIntention === "function"
        && Number.isInteger(value.EmojiIntention?.REACTION))?.EmojiIntention.REACTION;

    // The same list Discord's row starts from, without emojis it would refuse.
    function frequentEmojis(channel) {
        const context = store("EmojiStore")?.getDisambiguatedEmojiContext?.(channel.guild_id ?? null);
        const list = context?.getFrequentlyUsedReactionEmojisWithoutFetchingLatest?.();
        if (!Array.isArray(list)) return [];
        const check = emojiHelpers(), reaction = intention();
        return list.filter(emoji => {
            if (!emoji || (emoji.id == null && !emoji.optionallyDiverseSequence && !emoji.surrogates)) return false;
            if (!check?.isEmojiPremiumLocked || reaction == null) return emoji.id == null || emoji.guildId === channel.guild_id;
            try { return !check.isEmojiPremiumLocked({ emoji, channel, intention: reaction }); } catch { return false; }
        });
    }
    const keyOf = emoji => emoji.id ?? emoji.optionallyDiverseSequence ?? emoji.surrogates ?? emoji.name;
    function urlOf(emoji) {
        if (emoji.id != null) return `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? "gif" : "webp"}?size=48&quality=lossless`;
        try { return emojiHelpers()?.getURL?.(emoji.optionallyDiverseSequence ?? emoji.surrogates ?? "") || emoji.url || null; }
        catch { return emoji.url || null; }
    }
    // What Discord's reaction action takes.
    const reactionOf = emoji => ({ id: emoji.id ?? null, name: (emoji.id != null ? emoji.name : emoji.optionallyDiverseSequence ?? emoji.surrogates) ?? emoji.name ?? "", animated: Boolean(emoji.animated) });

    function closeMenu() {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
    }
    function fill(menu, channelId, messageId) {
        const shown = [...menu.querySelectorAll('[role="menuitem"][id^="message-quickreact-"]')];
        if (!shown.length || shown.length >= total || menu.querySelector(`.${extraClass}`)) return;
        const channel = store("ChannelStore")?.getChannel?.(channelId);
        const react = reactionAction();
        if (!channel || typeof react !== "function") return;
        // Discord shows the first four of the same list.
        const extra = frequentEmojis(channel).slice(shown.length, total);
        if (!extra.length) return;
        const model = shown.at(-1), row = model.parentElement;
        const suffix = /^item(_\w+)$/.exec([...model.classList].find(name => /^item_/.test(name)) ?? "")?.[1];
        const focusedClass = suffix ? `focused${suffix}` : null;
        for (const emoji of extra) {
            const src = urlOf(emoji);
            if (!src) continue;
            const item = model.cloneNode(true);
            item.id = `message-quickreact-lowcord-${keyOf(emoji)}`;
            item.classList.add(extraClass);
            if (focusedClass) item.classList.remove(focusedClass);
            item.removeAttribute("aria-labelledby");
            item.setAttribute("aria-label", `:${emoji.name}:`);
            item.tabIndex = -1;
            const image = item.querySelector("img");
            if (image) {
                image.src = src; image.srcset = ""; image.alt = `:${emoji.name}:`;
                image.removeAttribute("data-id"); image.removeAttribute("data-name");
            } else item.replaceChildren(Object.assign(document.createElement("img"), { src, alt: `:${emoji.name}:`, width: 24, height: 24, draggable: false }));
            const highlight = on => { if (focusedClass) item.classList.toggle(focusedClass, on); };
            const choose = event => {
                event.preventDefault(); event.stopPropagation();
                try { void Promise.resolve(react(channelId, messageId, reactionOf(emoji), "Message Context Menu")).catch(error => console.warn("[lowcord] quick reaction:", error)); }
                catch (error) { console.warn("[lowcord] quick reaction:", error); }
                // Like Discord's row: Shift keeps the menu open for another pick.
                if (!event.shiftKey) closeMenu();
            };
            item.addEventListener("click", choose);
            item.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") choose(event); });
            item.addEventListener("pointerenter", () => highlight(true));
            item.addEventListener("pointerleave", () => highlight(false));
            row.append(item);
        }
        row.setAttribute("data-lowcord-quick-reactions", "");
    }

    let menuRequest = 0;
    function onContextMenu(event) {
        const request = ++menuRequest;
        if (!(event.target instanceof Element)) return;
        const row = event.target.closest('[id^="chat-messages-"]');
        const [, channelId, messageId] = /^chat-messages-(\d+)-(\d+)$/.exec(row?.id ?? "") ?? [];
        if (!messageId) return;
        let frames = 0;
        const look = () => {
            if (request !== menuRequest || !enabled(ID)) return;
            const menu = document.querySelector('#message[role="menu"]');
            if (!menu?.querySelector('[id^="message-quickreact-"]')) { if (++frames < 30) requestAnimationFrame(look); return; }
            fill(menu, channelId, messageId);
        };
        requestAnimationFrame(look);
    }

    let active = false;
    function sync() {
        const on = enabled(ID);
        if (on === active) return;
        active = on;
        if (on) window.addEventListener("contextmenu", onContextMenu, true);
        else {
            window.removeEventListener("contextmenu", onContextMenu, true);
            document.querySelectorAll(`.${extraClass}`).forEach(item => item.remove());
        }
    }
    window.addEventListener(changeEvent, sync);
    sync();
})();
