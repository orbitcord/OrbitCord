import { test, expect } from "@playwright/test";

async function load(page) {
    await page.goto("/");
    await expect(page.locator("[data-lowcord-bubble]")).toHaveCount(6);
}
const bubble = (page, id) => page.locator(`#chat-messages-100-${id} [data-lowcord-bubble]`);
const settings = (page, value) => page.evaluate(value => window.__lowcordChatAppearance.setOptions(value), value);

test("wrapped bubbles fit their widest line instead of leaving a gap", async ({ page }) => {
    await load(page);
    // Long words wrap early, which leaves most of the last line's width unused.
    await page.evaluate(() => fixture.add(40, "self", '<div class="messageContent_test">'
        + "a ".repeat(40) + "supercalifragilisticexpialidocious-supercalifragilistic and the rest of the sentence</div>"));
    const gap = () => bubble(page, 40).evaluate(node => {
        const text = node.querySelector(".messageContent_test");
        const range = document.createRange(); range.selectNodeContents(text);
        const right = Math.max(...[...range.getClientRects()].map(rect => rect.right));
        return { gap: node.getBoundingClientRect().right - 12 - right, fitted: node.hasAttribute("data-lowcord-fit") };
    });
    await expect.poll(gap).toMatchObject({ fitted: true });
    expect((await gap()).gap).toBeLessThan(3);
    // A single line is already as narrow as its text.
    expect(await bubble(page, 2).evaluate(node => node.hasAttribute("data-lowcord-fit"))).toBe(false);
});

test("text colors are automatic until chosen", async ({ page }) => {
    await load(page);
    const color = id => bubble(page, id).evaluate(node => getComputedStyle(node).color);
    expect(await color(2)).toBe("rgb(255, 255, 255)");
    await settings(page, { outgoingTextColor: "#ffd700", incomingTextColor: "#123456" });
    await expect.poll(() => color(2)).toBe("rgb(255, 215, 0)");
    expect(await color(1)).toBe("rgb(18, 52, 86)");
    await settings(page, { outgoingTextColor: null, outgoingColor: "#ffffff" });
    await expect.poll(() => color(2)).toBe("rgb(0, 0, 0)");
    await settings(page, { incomingTextColor: "url(bad)" });
    expect(await page.evaluate(() => window.__lowcordChatAppearance.options.incomingTextColor)).toBeNull();
});
