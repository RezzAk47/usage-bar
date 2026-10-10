// Small inline SVG icons (no icon font, no remote files). All are decorative: the text next to them says the same.
const base = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' } as const;
export const Plus = () => <svg {...base}><path d="M8 3v10M3 8h10" /></svg>;
export const Minus = () => <svg {...base}><path d="M3 8h10" /></svg>;
export const Gear = () => <svg {...base}><circle cx="8" cy="8" r="5.4" stroke-width="2.6" stroke-dasharray="2.1 2.1" /><circle cx="8" cy="8" r="4" /><circle cx="8" cy="8" r="1.7" /></svg>;
export const Refresh = () => <svg {...base}><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" /></svg>;
export const Back = () => <svg {...base}><path d="M10 3.5L5.5 8 10 12.5" /></svg>;
export const Ok = () => <svg {...base}><circle cx="8" cy="8" r="6" fill="currentColor" stroke="none" /><path d="M5.2 8.3l2 2 3.6-4" stroke="var(--card)" /></svg>;
export const Warn = () => <svg {...base}><path d="M8 2.2L14.2 13H1.8z" fill="currentColor" stroke="none" /><path d="M8 6.5v3M8 11.2v.2" stroke="var(--card)" /></svg>;
export const Out = () => <svg {...base}><path d="M9 3h4v4M13 3L7.5 8.5M11 10v3H3V5h3" /></svg>;
export const Power = () => <svg {...base}><path d="M8 2v6M4.6 4.6a5.2 5.2 0 1 0 6.8 0" /></svg>;
