// The text next to the tray icon (macOS menu bar) and its tooltip (every OS).
import { Provider, worstRemaining } from './model';

/** '63% left' in every state (a bare '63%' could be read as used), '' while nothing is known. */
export function trayText(providers: Provider[]): string {
  const w = worstRemaining(providers);
  return w === null ? '' : `${w}% left`;
}

export function trayTooltip(providers: Provider[], stale: boolean): string {
  const w = worstRemaining(providers);
  if (w === null) return stale ? 'Usage Bar: usage unavailable' : 'Usage Bar';
  let where = '';
  for (const p of providers) {
    const l = p.limits.find((x) => x.remaining === w);
    if (l) { where = ` (${p.name}, ${l.label})`; break; }
  }
  return `Usage Bar: lowest ${w}% left${where}${stale ? ', could not refresh just now' : ''}`;
}
