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
  await wait(4000); // dashboard is the home screen; give it one generations poll
  await js(`document.querySelectorAll('.gen-head').forEach((h) => h.click())`); // expand stage details
  await wait(500);
  await shot("0-dashboard");
  if (process.env.GI_SMOKE_DASHBOARD_ONLY) return;
  if (process.env.GI_SMOKE_VIEW_RESULT) {
    // Reviewer path: dashboard -> View Result on the newest ready generation -> 360 view of that version.
    await js(`[...document.querySelectorAll('.gen-card button')].find((b) => b.textContent === 'View Result')?.click()`);
    // Wait until the viewer canvas exists and frames are flowing again (splat parse/upload can take a few seconds).
    const t0 = Date.now();
    await js(`new Promise((resolve) => { const check = () => document.querySelector('.viewport canvas') ? resolve(true) : setTimeout(check, 200); check(); })`);
    await js(`new Promise((resolve) => { let n = 0, last = performance.now(); const f = (t) => { n = t - last < 50 ? n + 1 : 0; last = t; n >= 30 ? resolve(true) : requestAnimationFrame(f); }; requestAnimationFrame(f); })`);
    console.log(`SETTLE ${Date.now() - t0}ms`);
    await shot("1-result");
    for (const name of ["Front", "Left", "Rear", "Right"]) {
      await js(`[...document.querySelectorAll('.hud button')].find((b) => b.textContent === ${JSON.stringify(name)})?.click()`);
      await wait(1800);
      await shot(`1-result-${name}`);
    }
    await js(`[...document.querySelectorAll('.hud button')].find((b) => b.textContent === 'Reset')?.click()`);
    await wait(1500);
  }
  if (process.env.GI_SMOKE_VIEW_RESULT && process.env.GI_SMOKE_ORBIT) {
    // Orbit recording: N frames around the vehicle at the Reset preset's distance and height.
    const n = Number(process.env.GI_SMOKE_ORBIT);
    fs.mkdirSync(path.join(out, "orbit"), { recursive: true });
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2 + Math.PI / 4;
      await js(`window.__giSetPose({ position: [${(12.7 * Math.cos(t)).toFixed(3)}, 5, ${(12.7 * Math.sin(t)).toFixed(3)}], target: [0, 1.4, 0] })`);
      await wait(i === 0 ? 1500 : 450); // camera rig eases toward each pose
      fs.writeFileSync(path.join(out, "orbit", `${String(i).padStart(3, "0")}.png`), (await win.webContents.capturePage()).toPNG());
    }
    console.log(`ORBIT ${n} frames`);
    return;
  }
  if (process.env.GI_SMOKE_VIEW_RESULT && process.env.GI_SMOKE_FPS) {
    const fps = await js(`new Promise((resolve) => {
      const names = ["Front", "Right", "Rear", "Left", "Reset"]; let i = 0;
      const click = () => [...document.querySelectorAll('.hud button')].find((b) => b.textContent === names[i++ % names.length])?.click();
      const iv = setInterval(click, 900); click();
      const dts = []; let last = performance.now(); const end = last + 6000;
      const tick = (t) => { dts.push(t - last); last = t; if (t < end) requestAnimationFrame(tick); else { clearInterval(iv); dts.sort((a, b) => a - b);
        const q = (p) => +dts[Math.floor(p * (dts.length - 1))].toFixed(1);
        resolve({ frames: dts.length, fps: +(dts.length / 6).toFixed(1), p50ms: q(0.5), p95ms: q(0.95), maxms: q(1) }); } };
      requestAnimationFrame(tick);
    })`);
    console.log("FPS " + JSON.stringify(fps));
    return;
  }
  if (process.env.GI_SMOKE_VIEW_RESULT) return;
  await js(`[...document.querySelectorAll('.sidebar button')].find(b => b.textContent.startsWith('3D Listings'))?.click()`);
  await wait(800);
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
  if (process.env.GI_SMOKE_FPS) {
    // Orbit through the presets for 6 s while sampling rAF intervals: p50/p95 frame time is what "laggy" means.
    const fps = await js(`new Promise((resolve) => {
      const names = ["Front", "Right", "Rear", "Left", "Reset"]; let i = 0;
      const click = () => [...document.querySelectorAll('.hud button')].find((b) => b.textContent === names[i++ % names.length])?.click();
      const iv = setInterval(click, 900); click();
      const dts = []; let last = performance.now(); const end = last + 6000;
      const tick = (t) => { dts.push(t - last); last = t; if (t < end) requestAnimationFrame(tick); else { clearInterval(iv); dts.sort((a, b) => a - b);
        const q = (p) => +dts[Math.floor(p * (dts.length - 1))].toFixed(1);
        resolve({ frames: dts.length, fps: +(dts.length / 6).toFixed(1), p50ms: q(0.5), p95ms: q(0.95), maxms: q(1) }); } };
      requestAnimationFrame(tick);
    })`);
    console.log("FPS " + JSON.stringify(fps));
  }
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
