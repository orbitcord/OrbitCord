import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
    await page.goto("/extensions");
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
});
// A new theme cross-fades in, so it lands a frame after the click.
const applied = page => page.evaluate(() => ({ id: document.documentElement.dataset.orbitcordTheme ?? null,
    sheets: document.querySelectorAll("#lowcord-theme").length }));
const css = page => page.evaluate(() => document.getElementById("lowcord-theme")?.textContent ?? "");
const themed = page => page.evaluate(() => {
    const node = document.createElement("div");
    node.className = "theme-dark"; node.id = "themed";
    document.body.append(node);
});
const token = (page, name) => page.locator("#themed").evaluate((node, name) => getComputedStyle(node).getPropertyValue(name).trim(), name);

test("Discord's own look adds nothing to the page", async ({ page }) => {
    expect(await applied(page)).toEqual({ id: null, sheets: 0 });
    expect(await page.evaluate(() => window.__lowcordThemes.state)).toEqual({ id: "discord", fonts: true, bubbles: true, font: "",
        custom: { background: "#1e1f24", accent: "#5865f2", text: null, radius: 8 } });
    await page.evaluate(() => localStorage.setItem("lowcord.theme", JSON.stringify({ id: "retired" })));
    await page.reload();
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
    expect(await applied(page)).toEqual({ id: null, sheets: 0 });
});

test("a theme repaints Discord's tokens from one stylesheet and persists", async ({ page }) => {
    await themed(page);
    await page.evaluate(() => window.__lowcordOpenSettings("themes"));
    await page.getByRole("radio", { name: /^Ember/ }).click();
    await expect(page.getByRole("radio", { name: /^Ember/ })).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => applied(page)).toEqual({ id: "ember", sheets: 1 });
    expect(await token(page, "--background-base-lowest")).toBe("#141211");
    // Amber is a light accent, so text on it is dark.
    expect(await token(page, "--control-primary-text-default")).toBe("#1c1208");
    await page.reload();
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
    expect(await applied(page)).toEqual({ id: "ember", sheets: 1 });
});

test("each theme loads only its own rules", async ({ page }) => {
    const ids = await page.evaluate(() => window.__lowcordThemes.catalog.map(theme => theme.id));
    expect(ids).toEqual(["fjord", "ember", "moss", "velvet", "phosphor", "custom"]);
    for (const id of ids) {
        await page.evaluate(id => window.__lowcordThemes.set({ id }), id);
        await expect.poll(() => applied(page)).toEqual({ id, sheets: 1 });
        const text = await css(page);
        expect(text).toContain(`[data-orbitcord-theme="${id}"]`);
        for (const other of ids.filter(other => other !== id)) {
            expect(text, `${id} carries ${other}`).not.toContain(`"${other}"`);
        }
    }
});

test("arrow keys move through the theme grid like a radio group", async ({ page }) => {
    await page.evaluate(() => window.__lowcordOpenSettings("themes"));
    await page.getByRole("radio", { name: /^Discord/ }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("radio", { name: /^Fjord/ })).toBeFocused();
    await expect.poll(() => applied(page)).toEqual({ id: "fjord", sheets: 1 });
    const columns = await page.evaluate(() => getComputedStyle(document.querySelector(".lowcord-theme-grid")).gridTemplateColumns.split(" ").length);
    await page.keyboard.press("ArrowDown");
    const below = await page.evaluate(index => window.__lowcordThemes.catalog[index - 1].id, 1 + columns);
    await expect.poll(() => applied(page)).toEqual({ id: below, sheets: 1 });
    await page.keyboard.press("Home");
    await expect(page.getByRole("radio", { name: /^Discord/ })).toBeFocused();
    await expect.poll(() => applied(page)).toEqual({ id: null, sheets: 0 });
});

test("theme typefaces and bubble colors can be turned off", async ({ page }) => {
    await page.evaluate(() => {
        const bubble = document.createElement("div");
        bubble.id = "bubble"; bubble.dataset.lowcordBubble = "outgoing";
        bubble.style.setProperty("--lowcord-bubble-color", "#123456");
        document.body.append(bubble);
        window.__lowcordThemes.set({ id: "velvet" });
    });
    const bubble = () => page.locator("#bubble").evaluate(node => getComputedStyle(node).getPropertyValue("--lowcord-bubble-color").trim());
    const font = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-primary"));
    await expect.poll(bubble).toBe("#c4a7e7");
    expect(await font()).toContain("Figtree");
    await page.evaluate(() => window.__lowcordOpenSettings("themes"));
    await page.getByRole("switch", { name: /Theme chat bubbles/ }).uncheck();
    await page.getByLabel("Typeface").selectOption({ label: "Discord’s" });
    expect(await bubble()).toBe("#123456");
    expect(await font()).not.toContain("Figtree");
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("lowcord.theme")))).toMatchObject({ id: "velvet", fonts: false, bubbles: false, font: "" });
    await page.getByLabel("Typeface").selectOption({ label: "Velvet Dusk’s own" });
    await expect.poll(font).toContain("Figtree");
    // Discord's own look has nothing to turn off.
    await page.getByRole("radio", { name: /^Discord/ }).click();
    await expect(page.getByRole("switch", { name: /Theme chat bubbles/ })).toBeDisabled();
});

test("theme typefaces render at one size, a little smaller in Phosphor", async ({ page }) => {
    const adjust = () => page.evaluate(() => getComputedStyle(document.documentElement).fontSizeAdjust);
    expect(await adjust()).toBe("none");
    for (const [id, value] of [["velvet", "0.47"], ["ember", "0.47"], ["phosphor", "0.44"]]) {
        await page.evaluate(id => window.__lowcordThemes.set({ id }), id);
        await expect.poll(adjust).toBe(value);
    }
    await page.evaluate(() => window.__lowcordThemes.set({ fonts: false }));
    await expect.poll(adjust).toBe("none");
});

test("going back to Discord's look removes the theme entirely", async ({ page }) => {
    await page.evaluate(() => window.__lowcordThemes.set({ id: "phosphor" }));
    await expect.poll(() => applied(page)).toEqual({ id: "phosphor", sheets: 1 });
    await page.evaluate(() => window.__lowcordThemes.set({ id: "discord" }));
    await expect.poll(() => applied(page)).toEqual({ id: null, sheets: 0 });
    expect(await page.evaluate(() => [...document.documentElement.attributes].map(attribute => attribute.name)
        .filter(name => name.startsWith("data-orbitcord")))).toEqual([]);
});

test("editing bubble colors during a theme takes the theme's colors over", async ({ page }) => {
    await page.evaluate(() => window.__lowcordThemes.set({ id: "velvet" }));
    await page.evaluate(() => window.__lowcordOpenSettings("appearance"));
    await expect(page.getByText("Showing Velvet Dusk’s colors")).toBeVisible();
    await page.getByLabel("Your messages text color").fill("#ffffff");
    await expect.poll(() => page.evaluate(() => window.__lowcordThemes.state.bubbles)).toBe(false);
    expect(await page.evaluate(() => window.__lowcordChatAppearance.options)).toMatchObject({
        outgoingColor: "#c4a7e7", outgoingTextColor: "#ffffff", incomingColor: "#393552", incomingTextColor: "#e0def4" });
    await expect(page.getByText("Showing Velvet Dusk’s colors")).toHaveCount(0);
});

test("a Discord font applies with or without a theme and lists only installed fonts", async ({ page }) => {
    const fonts = await page.evaluate(() => window.__lowcordThemes.fonts().flatMap(group => group.fonts.map(font => font.name)));
    expect(fonts[0]).toBe("System");
    expect(fonts).not.toContain("Not A Real Font");
    const primary = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-primary"));
    await page.evaluate(() => window.__lowcordOpenSettings("themes"));
    await page.getByLabel("Typeface").selectOption("System");
    await expect.poll(primary).toContain("system-ui");
    expect(await applied(page)).toEqual({ id: null, sheets: 1 });
    await page.evaluate(() => window.__lowcordThemes.set({ id: "phosphor" }));
    await expect.poll(() => applied(page)).toEqual({ id: "phosphor", sheets: 1 });
    expect(await primary()).toContain("system-ui");
    await page.evaluate(() => window.__lowcordThemes.set({ id: "discord", font: "Retired Font" }));
    await expect.poll(() => applied(page)).toEqual({ id: null, sheets: 0 });
});

test("a custom theme is shaded from the colors the user picks", async ({ page }) => {
    await themed(page);
    await page.evaluate(() => window.__lowcordOpenSettings("themes"));
    await page.getByLabel("Background color").fill("#102030");
    await expect.poll(() => applied(page)).toEqual({ id: "custom", sheets: 1 });
    await expect(page.getByRole("radio", { name: /^Custom/ })).toHaveAttribute("aria-checked", "true");
    expect(await token(page, "--background-base-lower")).toBe("#102030");
    await page.getByLabel("Accent color").fill("#f0c040");
    // A light accent takes dark text.
    await expect.poll(() => token(page, "--control-primary-text-default")).not.toBe("#ffffff");
    await page.getByRole("radio", { name: "Square" }).click();
    expect(await token(page, "--radius-sm")).toMatch(/^0(px)?$/);
    // Corners shape the chat bubbles too.
    const corner = () => page.evaluate(() => {
        const row = document.createElement("li");
        row.id = "chat-messages-1-1";
        row.innerHTML = '<div data-lowcord-cluster="solo"></div>';
        document.body.append(row);
        const value = getComputedStyle(row.firstChild).getPropertyValue("--lowcord-radius").trim();
        row.remove();
        return value;
    });
    expect(await corner()).toBe("4px");
    await page.getByRole("radio", { name: "Round" }).click();
    await expect.poll(corner).toBe("24px");
    // A light starting point turns the whole theme light.
    await page.getByRole("button", { name: "Paper" }).click();
    await expect(page.getByRole("button", { name: "Paper" })).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("light");
    await page.reload();
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
    expect(await page.evaluate(() => window.__lowcordThemes.state)).toMatchObject({ id: "custom",
        custom: { background: "#f6f3ee", accent: "#c2562b", text: "#2b2622", radius: 8 } });
    expect(await page.evaluate(() => document.documentElement.hasAttribute("data-orbitcord-theme-fonts"))).toBe(false);
});

test("an OrbitCord page covers Discord's page, including its layered parts", async ({ page }) => {
    await page.evaluate(() => {
        // Like Discord's Nitro page: a column raised to z-index 9.
        const content = document.createElement("div");
        content.className = "content_test";
        content.style.cssText = "position:relative;height:400px";
        content.innerHTML = `<div class="contentHeader_test"><button aria-label="Close">×</button></div>
            <div class="page_test" style="position:relative"><div id="layered" style="position:absolute;z-index:9;top:0;left:0;width:300px;height:300px;background:red"></div></div>`;
        document.querySelector("main").append(content);
    });
    await expect(page.locator(".lowcord-sidebar-section")).toHaveCount(1);
    await page.locator(".lowcord-sidebar-section [role=link]", { hasText: "Themes" }).click();
    await expect(page.locator(".lowcord-settings-inline")).toBeVisible();
    const top = () => page.evaluate(() => {
        const box = document.getElementById("layered").getBoundingClientRect();
        return document.elementFromPoint(box.left + 20, box.top + 20)?.closest(".lowcord-settings-inline, #layered")?.id || "orbitcord";
    });
    expect(await top()).toBe("orbitcord");
    expect(await page.locator('.content_test button[aria-label="Close"]').isVisible()).toBe(true);
});
