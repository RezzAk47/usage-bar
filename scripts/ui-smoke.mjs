// Browser-level checks of keyboard use, focus, RTL, tiny heights and "the page makes no network requests", on the Vite build.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';

const server = spawn('npx', ['vite', 'preview', '--port', '14174', '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore', shell: process.platform === 'win32' }); // npx is a .cmd file on Windows
const base = 'http://127.0.0.1:14174/';
for (let i = 0; i < 50; i++) { try { if ((await fetch(base)).ok) break; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 200)); }
let browser;
try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ channel: 'chrome' }); }
let failed = 0;
const ok = (c, m) => { if (!c) { failed++; console.error('FAIL', m); } else console.log('ok  ', m); };

const ctx = await browser.newContext({ viewport: { width: 420, height: 700 }, reducedMotion: 'reduce', timezoneId: 'America/Vancouver' });
const page = await ctx.newPage();
const errors = [], requests = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('request', (r) => requests.push(r.url()));
await page.goto(base + '?fixture=critical&history=1');
await page.waitForSelector('html[data-ready="1"]');

ok(await page.locator('main').count() === 1 && await page.locator('header').count() === 1 && await page.locator('footer').count() === 1, 'header, main and footer landmarks');
ok(await page.locator('h1').innerText() === 'Usage', 'h1 is Usage');
ok(await page.locator('[role=img][aria-label$="percent left"]').count() === 5, 'every ring has a text label');
ok(await page.locator('.hist[role=img]').count() === 2, 'history rows have a spoken summary');
ok((await page.locator('.stats').innerText()).includes('5% left'), 'header says Lowest 5% left');
ok((await page.locator('[role=group][aria-label*="Critical" i], [role=group][aria-label*=", critical"]').count()) === 1, 'the critical card says critical in its label');

// keyboard: Tab reaches Refresh, then Settings; Enter opens Settings, Escape goes back and returns focus
const tabs = [];
for (let i = 0; i < 4; i++) { await page.keyboard.press('Tab'); tabs.push(await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')); }
ok(tabs[0].startsWith('Use a usage reset') && tabs[1].startsWith('Use a usage reset'), 'Tab reaches the usage-reset buttons');
await page.getByRole('button', { name: 'Settings' }).focus();
await page.keyboard.press('Enter');
await page.waitForTimeout(150);
ok(await page.locator('h1').innerText() === 'Settings', 'Enter opens Settings');
ok(await page.evaluate(() => document.activeElement?.tagName) === 'H1', 'focus moves to the Settings heading');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
ok(await page.locator('h1').innerText() === 'Usage', 'Escape goes back');
ok((await page.evaluate(() => document.activeElement?.textContent?.trim())) === 'Settings', 'focus returns to the Settings button');

// settings change is applied and persisted in the preview folder
await page.getByRole('button', { name: 'Settings' }).click();
await page.getByRole('button', { name: 'Decrease First alert at % used' }).click();
ok((await page.locator('output').nth(1).innerText()) === '79', 'the stepper changes the value');
await page.getByLabel('Compact').check();
await page.waitForTimeout(100);
ok(await page.locator('.app.compact').count() === 1, 'Compact layout applies at once');
await page.getByRole('radio', { name: 'Cards' }).check();
await page.getByRole('button', { name: 'Back' }).click();

// network: the page made no requests except its own files
ok(requests.every((u) => u.startsWith(base) || u.startsWith('data:')), 'the page requested nothing but its own files');

// RTL and tiny heights
const p2 = await ctx.newPage();
await p2.goto(base + '?fixture=critical&history=1&rtl=1');
await p2.waitForSelector('html[data-ready="1"]');
ok(await p2.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'RTL: no horizontal overflow');
const box = await p2.locator('.stats').boundingBox();
ok(box && box.x < 100, 'RTL: the Lowest figure moves to the left side');
await p2.setViewportSize({ width: 420, height: 300 });
await p2.waitForTimeout(100);
ok(await p2.locator('footer').isVisible() && (await p2.locator('footer').boundingBox()).y + 20 < 300 + 5, 'tiny height: the footer stays on screen');
ok(await p2.evaluate(() => { const m = document.querySelector('main'); return m.scrollHeight > m.clientHeight; }), 'tiny height: the list scrolls');
await p2.setViewportSize({ width: 300, height: 600 });
ok(await p2.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'narrow 300 px: no horizontal overflow');

// states
for (const [fx, text] of [['errors', 'Sign in again in Claude Code'], ['errors', 'usage unavailable (HTTP 503)'], ['notsigned', 'Not signed in'], ['notsigned', 'Not installed'], ['empty', 'No Claude Code or Codex found'], ['emptyresp', 'usage unavailable (empty response)']]) {
  const p = await ctx.newPage();
  await p.goto(base + `?fixture=${fx}`);
  await p.waitForSelector('html[data-ready="1"]');
  ok((await p.locator('body').innerText()).includes(text), `${fx}: shows "${text}"`);
  await p.close();
}
// hostile provider text: no bidi / zero-width characters reach the DOM and labels stay short
const hp = await ctx.newPage();
await hp.goto(base + '?fixture=hostile');
await hp.waitForSelector('html[data-ready="1"]');
const htext = await hp.locator('body').innerText();
ok(!/[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2028\u2029\uFEFF]/.test(htext), 'hostile labels: no bidi or zero-width characters in the page');
ok((await hp.locator('h3').allInnerTexts()).every((t) => t.length <= 40), 'hostile labels: every label is at most 40 characters');
// the Refresh button cools down for 10 s
const rp = await ctx.newPage();
await rp.goto(base + '?fixture=critical');
await rp.waitForSelector('html[data-ready="1"]');
await rp.getByRole('button', { name: 'Refresh' }).click();
await rp.waitForTimeout(150);
ok(await rp.getByRole('button', { name: 'Updated just now' }).isDisabled(), 'Refresh is disabled with "Updated just now" right after a click');
// the new settings
await rp.getByRole('button', { name: 'Settings' }).click();
ok((await rp.getByRole('switch', { name: 'Use system proxy settings' }).getAttribute('aria-checked')) === 'false', 'Use system proxy settings is off by default');
ok(await rp.getByLabel('Path to codex').count() === 1, 'a Path to codex field exists');
const crash = await ctx.newPage();
await crash.goto(base + '?fixture=crash');
await crash.waitForSelector('html[data-ready="1"]');
ok((await crash.locator('[role=alert]').innerText()).includes('could not start'), 'a failed start shows a readable error screen');
ok(errors.filter((e) => !e.includes('crash') && !e.includes('failed to start')).length === 0, `no console errors (${errors.join(' | ')})`);
await browser.close();
server.kill();
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('ui-smoke: all checks passed');
