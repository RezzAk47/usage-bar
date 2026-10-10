import { describe, expect, it } from 'vitest';
import { DecodeError, stableStringify } from '../src/core/json';
import { defaultSettings, mergeSettings, parseSettings, settingsToObject } from '../src/core/settings';
import { SettingsStore } from '../src/core/settingsStore';
import { bumpMtime, nodeIO, tmpDir } from './helpers';
import { MemoryIO } from '../src/backend/memory';
import fs from 'node:fs';

describe('strict decode', () => {
  it('an empty object gives the defaults', () => {
    expect(parseSettings('{}').settings).toEqual(defaultSettings());
    expect(defaultSettings()).toMatchObject({ usageRows: 20, alertsOn: true, alertLow: 80, alertHigh: 95, showHistory: true, layout: 'cards', blur: 'medium', glass: 100 });
  });
  it('reads the Mac key names', () => {
    const p = parseSettings('{"usage_rows":5,"alerts_on":false,"alert_low":60,"alert_high":70,"show_history":false,"theme":"ocean","appearance":"dark","layout":"compact","glass":40,"blur":"strong"}');
    expect(p.settings).toEqual({ usageRows: 5, alertsOn: false, alertLow: 60, alertHigh: 70, showHistory: false, theme: 'ocean', appearance: 'dark', layout: 'compact', glass: 40, blur: 'strong', useSystemProxy: false, codexPath: '' });
    expect(p.notes).toEqual([]);
  });
  it('clamps: rows 3..20, alerts 50..99, glass steps of 5', () => {
    const p = parseSettings('{"usage_rows":1,"alert_low":10,"alert_high":150,"glass":47}').settings;
    expect([p.usageRows, p.alertLow, p.alertHigh, p.glass]).toEqual([3, 50, 99, 45]);
    expect(parseSettings('{"usage_rows":99.9}').settings.usageRows).toBe(20);
    expect(parseSettings('{"alert_low":79.9}').settings.alertLow).toBe(79);
  });
  it('wrong types fall back to the default and say so', () => {
    const p = parseSettings('{"usage_rows":"5","alerts_on":"yes","alert_low":true,"theme":"neon","layout":5,"glass":null,"blur":[]}');
    expect(p.settings).toEqual(defaultSettings());
    expect(p.notes.length).toBe(6);
  });
  it('NaN-like and huge numbers fall back', () => {
    expect(parseSettings('{"usage_rows":1e999}').settings.usageRows).toBe(20);
    expect(parseSettings('{"alert_high":-1e999}').settings.alertHigh).toBe(95);
  });
  it('invalid JSON or a non-object is a DecodeError', () => {
    for (const t of ['', '{', '[]', '5', 'null', '"x"']) expect(() => parseSettings(t)).toThrow(DecodeError);
  });
  it('a BOM is ignored', () => expect(parseSettings('﻿{"usage_rows":7}').settings.usageRows).toBe(7));
  it('unknown keys are kept, including __proto__ and the Mac agents keys', () => {
    const p = parseSettings('{"max_agents":12,"__proto__":{"polluted":true},"usage_rows":4,"future":[1]}');
    expect(Object.keys(p.extra).sort()).toEqual(['__proto__', 'future', 'max_agents']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const out = stableStringify(settingsToObject(p.settings, p.extra));
    expect(out).toContain('"__proto__"');
    expect(out).toContain('"max_agents": 12');
    expect(JSON.parse(out).usage_rows).toBe(4);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('merge applies only what changed here', () => {
    const base = defaultSettings(), mine = { ...base, theme: 'grape' as const }, disk = { ...base, usageRows: 5 };
    expect(mergeSettings(disk, mine, base)).toMatchObject({ theme: 'grape', usageRows: 5 });
  });
});

describe('SettingsStore on a real folder', () => {
  it('saves, keeps unknown keys, refuses to overwrite an unreadable file', async () => {
    const dir = tmpDir();
    fs.writeFileSync(`${dir}/settings.json`, '{"max_agents":12,"usage_rows":6}');
    const store = new SettingsStore(nodeIO(dir));
    await store.init();
    expect(store.settings.usageRows).toBe(6);
    await store.update({ theme: 'forest' });
    const disk = JSON.parse(fs.readFileSync(`${dir}/settings.json`, 'utf8'));
    expect(disk).toMatchObject({ max_agents: 12, usage_rows: 6, theme: 'forest' });
    fs.writeFileSync(`${dir}/settings.json`, '{broken');
    const s2 = new SettingsStore(nodeIO(dir));
    await s2.init();
    expect(s2.loadError).toMatch(/could not be read/);
    await s2.update({ theme: 'mono' });
    expect(fs.readFileSync(`${dir}/settings.json`, 'utf8')).toBe('{broken');
  });
  it('a hand edit while the app runs is merged', async () => {
    const dir = tmpDir();
    const store = new SettingsStore(nodeIO(dir));
    await store.init();
    await store.update({ theme: 'ocean' });
    const edited = { ...JSON.parse(fs.readFileSync(`${dir}/settings.json`, 'utf8')), usage_rows: 9 };
    fs.writeFileSync(`${dir}/settings.json`, JSON.stringify(edited));
    const t = new Date(Date.now() + 5000); fs.utimesSync(`${dir}/settings.json`, t, t);
    await store.update({ alertLow: 60 });
    expect(JSON.parse(fs.readFileSync(`${dir}/settings.json`, 'utf8'))).toMatchObject({ theme: 'ocean', usage_rows: 9, alert_low: 60 });
  });
});

describe('SettingsStore races and error values', () => {
  it('a hand edit that lands between the read and the write of a save is not lost', async () => {
    const dir = tmpDir();
    const io = nodeIO(dir);
    const store = new SettingsStore(io);
    await store.init();
    await store.update({ theme: 'ocean' });
    // the next read of settings.json is followed at once by an outside edit (an editor, another tool) before our write
    let armed = true;
    const racy = {
      ...io,
      async read(n: string) {
        const t = await io.read(n);
        if (armed && n === 'settings.json' && t !== null) {
          armed = false;
          fs.writeFileSync(`${dir}/settings.json`, JSON.stringify({ ...JSON.parse(t), usage_rows: 7, hand: 'edit' }));
          bumpMtime(`${dir}/settings.json`);
        }
        return t;
      },
    };
    (store as unknown as { io: typeof racy }).io = racy;
    await store.update({ alertLow: 60 });
    const disk = JSON.parse(fs.readFileSync(`${dir}/settings.json`, 'utf8'));
    expect(disk).toMatchObject({ theme: 'ocean', alert_low: 60, usage_rows: 7, hand: 'edit' });
    expect(store.saveError).toBeNull();
  });

  it('a backup that cannot be made reports the real reason, not "undefined"', async () => {
    const mem = new MemoryIO();
    await mem.write('settings.json', '{broken');
    mem.moveAside = async () => { throw 'could not keep a backup of settings.json: disk full'; }; // Tauri rejects with a string
    const store = new SettingsStore(mem);
    await store.init();
    await store.resetToDefaults();
    expect(store.saveError).toContain('disk full');
    expect(store.saveError).not.toContain('undefined');
  });

  it('a failed write reports the real reason when the error is a plain string', async () => {
    const mem = new MemoryIO();
    mem.write = async () => { throw 'could not write settings.json: read-only file system'; };
    const store = new SettingsStore(mem);
    await store.init();
    await store.update({ theme: 'grape' });
    expect(store.saveError).toContain('read-only file system');
  });
});
