import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";

async function image(page, type = "image/png", name = "Screenshot 2026-10-03 at 4.19.04 AM.png") {
    const bytes = await page.evaluate(async type => {
        const canvas = document.createElement("canvas");
        canvas.width = 128; canvas.height = 96;
        const context = canvas.getContext("2d");
        context.fillStyle = "#189f98"; context.fillRect(0, 0, 128, 96);
        context.fillStyle = "#fff"; context.fillRect(12, 12, 48, 48);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, type));
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
    }, type);
    return { name, mimeType: type, buffer: Buffer.from(bytes) };
}
const gif = {name:"animation.gif",mimeType:"image/gif",buffer:Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")};
const hash = buffer => createHash("sha256").update(buffer).digest("hex");

test.beforeEach(async ({page}) => {
    await page.goto("/uploads");
    await expect(page.locator("#state")).toHaveText("Idle");
});

test("native PNG preview and actual upload preserve every byte and Unicode filename", async ({page}) => {
    const file = await image(page);
    await page.getByLabel("Attach files").setInputFiles(file);
    await expect(page.locator("article")).toHaveAttribute("data-preview", "ready");
    await expect(page.locator("article span")).toHaveText(file.name);
    await page.getByRole("button", {name:"Send test upload"}).click();
    await expect(page.locator("#state")).toHaveText("Sent");
    expect(await page.evaluate(() => window.receipts)).toEqual([{size:file.buffer.length,type:file.mimeType,hash:hash(file.buffer),signature:file.buffer.subarray(0,8).toString("hex")}]);
    await expect(page.locator("article")).toHaveCount(0);
});

test("native JPEG upload keeps original bytes, type and filename", async ({page}) => {
    const file = await image(page, "image/jpeg", "photo.jpg");
    await page.getByLabel("Attach files").setInputFiles(file);
    await expect(page.locator("article")).toHaveAttribute("data-preview", "ready");
    await expect(page.locator("article span")).toHaveText("photo.jpg");
    const prepared = await page.evaluate(async () => {
        const entry = window.prepared[0];
        return {type:entry.file.type,size:entry.file.size,metadata:entry.compressionMetadata,bytes:Array.from(new Uint8Array(await entry.file.arrayBuffer()))};
    });
    expect(prepared.metadata).toEqual({originalContentType:"image/jpeg",preCompressionSize:file.buffer.length});
    expect(prepared.size).toBe(file.buffer.length);
    await page.getByRole("button", {name:"Send test upload"}).click();
    await expect(page.locator("#state")).toHaveText("Sent");
    const receipt = await page.evaluate(() => window.receipts[0]);
    expect(receipt).toMatchObject({size:file.buffer.length,type:"image/jpeg",hash:hash(file.buffer)});
    expect(receipt.signature.startsWith("ffd8ff")).toBe(true);
});

test("mixed file drop keeps order, animation, video and document bytes; sends only on demand", async ({page}) => {
    const files = [await image(page, "image/jpeg", "photo.jpg"), gif,
        {name:"clip.mp4",mimeType:"video/mp4",buffer:Buffer.from("opaque video upload bytes")},
        {name:"notes.pdf",mimeType:"application/pdf",buffer:Buffer.from("%PDF-1.7\nfixture")},
        {name:"vector.svg",mimeType:"image/svg+xml",buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="teal"/></svg>')}];
    const transfer = await page.evaluateHandle(files => {
        const data = new DataTransfer();
        for(const file of files) data.items.add(new File([new Uint8Array(file.bytes)], file.name, {type:file.type}));
        return data;
    }, files.map(file => ({name:file.name,type:file.mimeType,bytes:Array.from(file.buffer)})));
    await page.locator("#drop").dispatchEvent("drop", {dataTransfer:transfer});
    await transfer.dispose();
    await expect(page.locator("article span")).toHaveText(["photo.jpg","animation.gif","clip.mp4","notes.pdf","vector.svg"]);
    await expect(page.locator('article[data-type="image/gif"]')).toHaveAttribute("data-preview", "ready");
    expect(await page.evaluate(() => window.receipts.length)).toBe(0);
    await page.getByRole("button", {name:"Send test upload"}).click();
    await expect(page.locator("#state")).toHaveText("Sent");
    const receipts = await page.evaluate(() => window.receipts);
    expect(receipts).toHaveLength(files.length);
    for(let i=0;i<files.length;i++) expect(receipts[i]).toMatchObject({type:files[i].mimeType,size:files[i].buffer.length,hash:hash(files[i].buffer)});
});

test("undecodable image still uploads original bytes without blocking other files", async ({page}) => {
    await page.getByLabel("Attach files").setInputFiles([{name:"unsupported.heic",mimeType:"image/heic",buffer:Buffer.from("unsupported fixture")}, gif]);
    await expect(page.locator("#state")).toHaveText("Ready");
    await expect(page.locator("article")).toHaveCount(2);
    await page.getByRole("button", {name:"Send test upload"}).click();
    await expect(page.locator("#state")).toHaveText("Sent");
    expect(await page.evaluate(() => window.receipts.map(receipt => receipt.hash))).toEqual([hash(Buffer.from("unsupported fixture")), hash(gif.buffer)]);
});

test("native image previews decode at full dimensions", async ({page}) => {
    const file = await image(page);
    await page.getByLabel("Attach files").setInputFiles(file);
    await expect(page.locator("article")).toHaveAttribute("data-preview", "ready");
    expect(await page.locator("article img").evaluate(img => [img.naturalWidth,img.naturalHeight])).toEqual([128,96]);
});

test("cancelled transfer retains the draft for retry", async ({page}) => {
    await page.goto("/uploads?slow");
    await page.getByLabel("Attach files").setInputFiles(gif);
    await expect(page.locator("#state")).toHaveText("Ready");
    await page.getByRole("button", {name:"Send test upload"}).click();
    await expect(page.locator("#state")).toHaveText("Uploading");
    await page.getByRole("button", {name:"Cancel test upload"}).click();
    await expect(page.locator("#state")).toHaveText("Cancelled");
    await expect(page.locator("article")).toHaveCount(1);
    await page.getByRole("button", {name:"Send test upload"}).click();
    await expect(page.locator("#state")).toHaveText("Sent");
    expect(await page.evaluate(() => window.receipts[0].hash)).toBe(hash(gif.buffer));
});

test("server rejection preserves the draft and never reports success", async ({page}) => {
    await page.goto("/uploads?fail");
    await page.getByLabel("Attach files").setInputFiles(gif);
    await expect(page.locator("#state")).toHaveText("Ready");
    await page.getByRole("button", {name:"Send test upload"}).click();
    await expect(page.locator("#state")).toHaveText("Failed");
    await expect(page.locator("article")).toHaveCount(1);
    expect(await page.evaluate(() => window.receipts)).toEqual([]);
});
