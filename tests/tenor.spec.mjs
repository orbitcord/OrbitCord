import { test, expect } from "@playwright/test";

const tenorSearch = {
    results: [{ id: "42", title: "Dog", itemurl: "https://tenor.com/view/dog-42",
        media_formats: { webm: { url: "https://media.tenor.com/a/dog.webm", dims: [320, 240] },
            tinygif: { url: "https://media.tenor.com/a/dog.gif", dims: [220, 165] },
            gifpreview: { url: "https://media.tenor.com/a/dog.png", dims: [220, 165] } } }],
};

async function setup(page) {
    await page.goto("/extensions");
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
    await page.evaluate(body => {
        window.__tenorCalls = [];
        window.__LOWCORD_NATIVE__ = { ...(window.__LOWCORD_NATIVE__ ?? {}), fetchRemote: async url => {
            window.__tenorCalls.push(url);
            const endpoint = new URL(url).pathname.split("/").pop();
            const data = endpoint === "categories" ? { tags: [{ searchterm: "hello", image: "https://media.tenor.com/h.gif" }] }
                : endpoint === "autocomplete" ? { results: ["dog", "dog meme"] } : body;
            return { status: 200, headers: {}, body: JSON.stringify(data) };
        } };
    }, tenorSearch);
    await page.addScriptTag({ url: "/injection/tenor.js" });
}
const get = (page, path) => page.evaluate(path => new Promise(resolve => {
    const request = new XMLHttpRequest();
    request.open("GET", `${location.origin}/api/v9${path}`);
    request.onload = () => resolve({ status: request.status, body: JSON.parse(request.responseText || "null") });
    request.onerror = () => resolve({ status: 0 });
    request.send();
}), path);

test("Discord's GIF search, trending and suggestions are answered from Tenor", async ({ page }) => {
    await setup(page);
    const search = await get(page, "/gifs/search?q=dog&media_format=webm&provider=klipy&locale=en-US&limit=50");
    expect(search.status).toBe(200);
    expect(search.body).toEqual([{ id: "42", title: "Dog", url: "https://tenor.com/view/dog-42", src: "https://media.tenor.com/a/dog.webm",
        gif_src: "https://media.tenor.com/a/dog.gif", width: 320, height: 240, preview: "https://media.tenor.com/a/dog.png" }]);
    const trending = await get(page, "/gifs/trending?provider=klipy&locale=en-US&media_format=webm");
    expect(trending.body.categories).toEqual([{ name: "hello", src: "https://media.tenor.com/h.gif" }]);
    expect(trending.body.gifs).toHaveLength(1);
    expect((await get(page, "/gifs/suggest?q=dog&limit=5")).body).toEqual(["dog", "dog meme"]);
    const call = new URL((await page.evaluate(() => window.__tenorCalls))[0]);
    expect(call.hostname).toBe("tenor.googleapis.com");
    expect(call.searchParams.get("q")).toBe("dog");
    expect(call.searchParams.get("locale")).toBe("en_US");
});

test("turning Bring back Tenor off lets the request reach Discord", async ({ page }) => {
    await setup(page);
    await page.evaluate(() => window.Lowcord.extensions.set("bringBackTenor", false));
    await get(page, "/gifs/search?q=dog&media_format=webm");
    expect(await page.evaluate(() => window.__tenorCalls.length)).toBe(0);
});

test("the GIF picker's source menu switches between Klipy and Tenor and refetches what it shows", async ({ page }) => {
    await setup(page);
    await page.evaluate(() => {
        window.pickerCalls = [];
        const view = { query: "dog", getQuery() { return this.query; } };
        view.constructor = { displayName: "GIFPickerViewStore" };
        const actions = {
            trending() { /* GIF_PICKER_TRENDING_FETCH_SUCCESS trendingGIFPreview */ window.pickerCalls.push("trending"); },
            search(query, type) { /* type:"GIF_PICKER_QUERY",query: arguments.length>2 */ window.pickerCalls.push(`search:${query}:${arguments.length > 2}`); },
        };
        webpackChunkdiscord_app[0][2]({ c: { gifPicker: { exports: { view, ...actions } } } });
        const panel = document.createElement("div");
        panel.id = "gif-picker-tab-panel";
        panel.innerHTML = '<div class="header_1"><div class="searchBar_1"><input type="text" placeholder="Search KLIPY"></div></div>';
        document.body.append(panel);
    });
    await page.addStyleTag({ url: "/injection/ui-extras.css" });
    const menu = page.getByRole("combobox", { name: "GIF source" });
    await expect(menu).toHaveValue("tenor");
    await expect(page.locator("#gif-picker-tab-panel input")).toHaveAttribute("placeholder", "Search Tenor");
    const row = await page.locator("[data-lowcord-gif-source-row]").evaluate(node => getComputedStyle(node).display);
    expect(row).toBe("flex");

    await menu.selectOption("klipy");
    await expect.poll(() => page.evaluate(() => Lowcord.extensions.enabled("bringBackTenor"))).toBe(false);
    await expect(page.locator("#gif-picker-tab-panel input")).toHaveAttribute("placeholder", "Search KLIPY");
    expect(await page.evaluate(() => window.pickerCalls)).toEqual(["trending", "search::false", "search:dog:true"]);

    // The settings switch moves the menu too.
    await page.evaluate(() => Lowcord.extensions.set("bringBackTenor", true));
    await expect(menu).toHaveValue("tenor");
    await expect.poll(() => page.evaluate(() => window.pickerCalls.length)).toBe(6);
});
