import { test, expect } from "@playwright/test";

for (const [menuId, contentHeight] of [["switch-accounts-submenu", 189], ["message-actions", 596], ["message", 596]]) {
test(`${menuId} keeps its full list while retaining viewport scrolling`, async ({ page }) => {
    await page.goto("/extensions");
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
    await page.evaluate(({ menuId, contentHeight }) => {
        const layer = document.createElement("div");
        layer.style.setProperty("--reference-position-layer-max-height", "119px");
        layer.innerHTML = [menuId, "other-submenu"].map(id => `
            <div id="${id}" role="menu" style="display:flex; flex-direction:column; width:220px;
                --custom-menu-viewport-padding:48px; max-height:var(--reference-position-layer-max-height)">
                <div style="overflow-y:auto; min-height:0">
                    <div style="height:${contentHeight}px">Menu actions</div>
                </div>
            </div>`).join("");
        document.body.append(layer);
    }, { menuId, contentHeight });
    const sizes = id => page.locator(`#${id}`).evaluate(menu => ({
        height: menu.clientHeight,
        visible: menu.firstElementChild.clientHeight,
        content: menu.firstElementChild.scrollHeight,
    }));
    expect(await sizes(menuId)).toEqual({ height: contentHeight, visible: contentHeight, content: contentHeight });
    expect((await sizes("other-submenu")).height).toBe(119);
    // Scrolling remains available when the list really exceeds the viewport.
    await page.setViewportSize({ width: 1000, height: 200 });
    expect(await sizes(menuId)).toEqual({ height: 152, visible: 152, content: contentHeight });
});
}
