import { test, expect } from '@playwright/test';

// Element.animate is recorded, so the checks don't race the animations' end.
test.beforeEach(async ({ page }) => {
    await page.goto('/extensions');
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
    await page.addStyleTag({ url: '/injection/animations.css' });
    await page.evaluate(async () => {
        window.animated = [];
        const animate = Element.prototype.animate;
        Element.prototype.animate = function (...args) { animated.push(this.id || this.className); return animate.apply(this, args); };
        const list = document.createElement('ol');
        list.dataset.listId = 'chat-messages';
        list.innerHTML = Array.from({ length: 20 }, (_, index) => `<li id="chat-messages-1-${index}"><div class="message_t">Message ${index}</div></li>`).join('')
            + '<div class="scrollerSpacer_t"></div>';
        document.body.append(list);
        const script = document.createElement('script');
        script.textContent = await (await fetch('/injection/smooth-animations.js')).text();
        document.head.append(script);
        await new Promise(requestAnimationFrame);
    });
});
const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const message = id => `Object.assign(document.createElement('li'), { id: 'chat-messages-1-${id}', innerHTML: '<div class="message_t">New</div>' })`;

test('a new message at the end animates in; channel loads, history and sent-message swaps do not', async ({ page }) => {
    await page.evaluate(`document.querySelector('ol').insertBefore(${message('new')}, document.querySelector('.scrollerSpacer_t'))`);
    await frame(page);
    expect(await page.evaluate(() => animated.splice(0))).toEqual(['chat-messages-1-new']);
    // History loading above.
    await page.evaluate(`document.querySelector('ol').prepend(${message('old')})`);
    // A sent message taking its real id: one leaves as another arrives.
    await page.evaluate(`document.querySelector('#chat-messages-1-new').replaceWith(${message('sent')})`);
    await frame(page);
    // A channel's worth at once.
    await page.evaluate(`for (let i = 0; i < 5; i++) document.querySelector('ol').insertBefore(${message("bulk-' + i + '")}, document.querySelector('.scrollerSpacer_t'))`);
    await frame(page);
    expect(await page.evaluate(() => animated)).toEqual([]);
});

test('a reaction added to a message on screen pops in, but not one drawn with its message', async ({ page }) => {
    await page.evaluate(() => {
        const reactions = document.createElement('div');
        reactions.className = 'reactions_t';
        reactions.innerHTML = '<div class="reaction_t" id="first-reaction">👍 1</div>';
        document.querySelector('#chat-messages-1-3').append(reactions);
    });
    await frame(page);
    await page.evaluate(() => document.querySelector('.reactions_t').insertAdjacentHTML('beforeend', '<div class="reaction_t" id="second-reaction">🔥 1</div>'));
    await frame(page);
    await page.evaluate(`document.querySelector('ol').insertBefore(Object.assign(${message('with-reaction')}, { innerHTML: '<div class="reactions_t"><div class="reaction_t" id="drawn">😀 1</div></div>' }), document.querySelector('.scrollerSpacer_t'))`);
    await frame(page);
    expect(await page.evaluate(() => animated)).toEqual(['first-reaction', 'second-reaction', 'chat-messages-1-with-reaction']);
});

test('the user profile panel pushes in at full width and pushes back out on close', async ({ page }) => {
    await page.evaluate(() => {
        const row = document.createElement('div');
        row.className = 'content_t'; row.id = 'row'; row.style.cssText = 'display:flex;width:900px';
        row.innerHTML = '<main class="chat_t" id="chat" style="flex:1 1 auto">Chat</main>';
        document.body.append(row);
    });
    await frame(page);
    await page.evaluate(() => document.getElementById('row').insertAdjacentHTML('beforeend', '<aside class="aside_t" id="profile" style="width:320px"><div id="card">Profile</div></aside>'));
    await frame(page);
    expect(await page.evaluate(() => animated.splice(0))).toEqual(['profile']);
    // Early on, the panel keeps its width and the chat gives way only partly.
    const early = await page.evaluate(() => ({ panel: profile.offsetWidth, chat: chat.offsetWidth, margin: getComputedStyle(profile).marginRight, clip: row.style.overflowX }));
    expect(early.panel).toBe(320);
    expect(early.chat).toBeGreaterThan(580);
    expect(parseFloat(early.margin)).toBeLessThan(0);
    expect(early.clip).toBe('clip');
    await expect.poll(() => page.evaluate(() => [chat.offsetWidth, getComputedStyle(profile).marginRight, row.style.overflowX])).toEqual([580, '0px', '']);
    // Closing: an inert copy without ids slides back out, then leaves.
    await page.evaluate(() => profile.remove());
    await frame(page);
    const copy = await page.evaluate(() => { const copy = row.querySelector('[data-lowcord-closing]'); return copy && { inert: copy.inert, hidden: copy.getAttribute('aria-hidden'), ids: copy.querySelectorAll('[id]').length + (copy.id ? 1 : 0) }; });
    expect(copy).toEqual({ inert: true, hidden: 'true', ids: 0 });
    expect(await page.evaluate(() => animated.splice(0))).toEqual(['aside_t']);
    await expect.poll(() => page.evaluate(() => [row.children.length, chat.offsetWidth, row.style.overflowX])).toEqual([1, 900, '']);
    // Reopened mid-close: the copy goes and the new panel carries on from there.
    await page.evaluate(() => row.insertAdjacentHTML('beforeend', '<aside class="aside_t" id="profile2" style="width:320px">Profile</aside>'));
    await frame(page);
    await page.evaluate(() => profile2.remove());
    await frame(page);
    await page.evaluate(() => row.insertAdjacentHTML('beforeend', '<aside class="aside_t" id="profile3" style="width:320px">Profile</aside>'));
    await frame(page);
    expect(await page.evaluate(() => row.querySelectorAll('[data-lowcord-closing]').length)).toBe(0);
    await expect.poll(() => page.evaluate(() => chat.offsetWidth)).toBe(580);
    await page.evaluate(() => { animated.length = 0; });
    // Switching to another DM draws a new chat and panel together.
    await page.evaluate(() => { row.innerHTML = '<main class="chat_t" style="flex:1 1 auto">Other chat</main><aside class="aside_t" style="width:320px">Profile</aside>'; });
    await frame(page);
    expect(await page.evaluate(() => animated)).toEqual([]);
});

test('nothing animates with the extension off, Discord reduce motion, or the system setting', async ({ page }) => {
    const add = async id => { await page.evaluate(`document.querySelector('ol').insertBefore(${message(id)}, document.querySelector('.scrollerSpacer_t'))`); await frame(page); };
    await page.evaluate(() => Lowcord.extensions.set('smoothAnimations', false));
    await add('off');
    await page.evaluate(() => { Lowcord.extensions.set('smoothAnimations', true); document.documentElement.classList.add('reduce-motion'); });
    await add('discord-reduced');
    await page.evaluate(() => document.documentElement.classList.remove('reduce-motion'));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await add('system-reduced');
    expect(await page.evaluate(() => animated)).toEqual([]);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await add('on');
    expect(await page.evaluate(() => animated)).toEqual(['chat-messages-1-on']);
});

test('menus, bars and presses use the shared ease-out, scoped to their elements', async ({ page }) => {
    await page.evaluate(() => {
        document.documentElement.setAttribute('data-lowcord-animations', '');
        document.body.insertAdjacentHTML('beforeend', `<div class="layerContainer_t"><div role="menu" id="menu">Menu</div></div>
            <div class="channelTextArea_t"><div class="autocomplete_t" id="autocomplete">Suggestions</div></div>
            <button class="button_t lookFilled_t" id="button">Send</button><div class="container_t" id="unrelated">Other</div>`);
    });
    const style = (id, property) => page.evaluate(([id, property]) => getComputedStyle(document.getElementById(id))[property], [id, property]);
    expect(await style('menu', 'animationName')).toBe('lowcord-anim-pop-in');
    expect(await style('menu', 'animationDuration')).toBe('0.15s');
    expect(await style('menu', 'animationTimingFunction')).toBe('cubic-bezier(0.23, 1, 0.32, 1)');
    expect(await style('autocomplete', 'animationName')).toBe('lowcord-anim-rise-in');
    expect(await style('button', 'transitionProperty')).toBe('transform, background-color, color, border-color, box-shadow');
    expect(await style('unrelated', 'animationName')).toBe('none');
    expect(await style('unrelated', 'transitionProperty')).toBe('all');
    await page.evaluate(() => document.documentElement.classList.add('reduce-motion'));
    expect(await style('menu', 'animationName')).toBe('none');
    expect(await style('button', 'transitionProperty')).toBe('all');
});
