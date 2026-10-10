// UI screenshots with fixture data (made-up numbers), light and dark, against the Vite build. Output: shots/*.png
// Usage: npm run build && npm run shots     (CI uploads shots/ as an artifact)
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const out = process.env.SHOTS_DIR ?? 'shots';
fs.mkdirSync(out, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '14173', '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore', shell: process.platform === 'win32' }); // npx is a .cmd file on Windows
const base = 'http://127.0.0.1:14173/';
for (let i = 0; i < 50; i++) { try { if ((await fetch(base)).ok) break; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 200)); }
let browser;
try { browser = await chromium.launch(); } catch (e) { console.error('bundled chromium missing, trying system Chrome:', e.message); browser = await chromium.launch({ channel: 'chrome' }); }

const S = (o) => '&settings=' + encodeURIComponent(JSON.stringify(o));
const shots = [
  { name: 'normal', url: '?fixture=normal&history=1' },
  { name: 'critical', url: '?fixture=critical' },
  { name: 'history', url: '?fixture=critical&history=1' },
  { name: 'settings', url: '?fixture=critical', act: async (p) => { await p.getByRole('button', { name: 'Settings' }).click(); } },
  { name: 'errors', url: '?fixture=errors' },
  { name: 'notsigned', url: '?fixture=notsigned' },
  { name: 'empty', url: '?fixture=empty' },
  { name: 'compact', url: '?fixture=critical&history=1' + S({ layout: 'compact', theme: 'forest' }) },
  { name: 'solid', url: '?fixture=critical' + S({ layout: 'solid', theme: 'ocean' }) },
  { name: 'glass', url: '?fixture=critical&history=1' + S({ layout: 'glass', theme: 'grape', glass: 60 }) },
  { name: 'rtl', url: '?fixture=critical&history=1&rtl=1' },
];
for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 800 }, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: 'reduce', timezoneId: 'America/Vancouver', locale: 'en-GB' });
  for (const s of shots) {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('page error:', e.message));
    await page.goto(base + s.url);
    await page.waitForSelector('html[data-ready="1"]');
    await page.waitForTimeout(150);
    if (s.act) { await s.act(page); await page.waitForTimeout(150); }
    await page.screenshot({ path: `${out}/${s.name}-${scheme}.png` });
    await page.close();
  }
  await ctx.close();
}
await browser.close();
server.kill();
console.log('screenshots written to', out);
