import type { BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";

// Smoke check for the shell: GI_SMOKE_OUT=<dir> GI_SMOKE_QUERY=<text> clicks through the first listing and writes screenshots.
export async function smoke(win: BrowserWindow, out: string, query: string) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const js = (code: string) => win.webContents.executeJavaScript(code);
  const shot = async (name: string) => fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const errors: string[] = [];
  win.webContents.on("console-message", (e) => e.level === "error" && errors.push(e.message));
  fs.mkdirSync(out, { recursive: true });
  await wait(1500);
  await js(`(() => { const i = document.querySelector('.browser input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(query)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await wait(2500);
  await shot("1-search");
  await js(`document.querySelector('.browser li')?.click()`);
  await wait(4000);
  await shot("2-listing");
  await js(`[...document.querySelectorAll('header button')].find(b => b.textContent === 'Edit tags')?.click()`);
  await wait(9000);
  await js(`document.querySelector('.parts button')?.click()`); // first tag: moves the camera to its saved pose
  await wait(3000);
  await shot("2b-first-tag");
  await js(`[...document.querySelectorAll('header button')].find(b => b.textContent === 'Edit tags')?.click()`);
  await wait(12000); // GLB + HDRI load
  await shot("3-editor");
  for (const name of (process.env.GI_SMOKE_TAGS ?? "").split(",").filter(Boolean)) {
    await js(`[...document.querySelectorAll('.parts button')].find(b => b.textContent.startsWith(${JSON.stringify(name)}))?.click()`);
    await wait(1800);
    await shot(`6-${name.replace(/\W+/g, "-")}`);
  }
  for (const name of (process.env.GI_SMOKE_PRESETS ?? "").split(",").filter(Boolean)) {
    await js(`[...document.querySelectorAll('.hud button')].find(b => b.textContent === ${JSON.stringify(name)})?.click()`);
    await wait(1500);
    await shot(`5-${name}`);
  }
  await js(`[...document.querySelectorAll('.tabs button')].find(b => b.textContent.startsWith('Versions'))?.click()`);
  await wait(800);
  await shot("4-versions");
  const summary = await js(`({ items: document.querySelectorAll('.browser li').length, photos: document.querySelectorAll('.photos img').length, specs: document.querySelectorAll('dl dt').length, state: document.querySelector('.viewport-state')?.textContent ?? null, title: document.querySelector('.viewer header .title')?.textContent ?? null })`);
  console.log(JSON.stringify({ ...summary, errors }));
}
