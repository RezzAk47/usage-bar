// JSON with sorted keys (like the Mac app writes it) and the strict-decode helpers used by tasks.json and settings.json.

export type Extra = Record<string, unknown>;

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function stableStringify(value: unknown, indent = 2): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (isObject(v)) {
      const out: Record<string, unknown> = Object.create(null); // a key named __proto__ must stay an ordinary key
      for (const k of Object.keys(v).sort()) {
        if (v[k] !== undefined) out[k] = sort(v[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value), null, indent);
}

/** The text of a JSON value for an error message: 50.5, "50", true. */
export function shown(v: unknown): string {
  if (typeof v === 'string') return `"${v}"`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'a list';
  return 'an object';
}

/** The keys of an object that the app does not know: they are kept and written back. */
export function unknownKeys(obj: Record<string, unknown>, known: readonly string[]): Extra | undefined {
  const extra: Extra = Object.create(null);
  let any = false;
  for (const k of Object.keys(obj)) {
    if (!known.includes(k)) { extra[k] = obj[k]; any = true; }
  }
  return any ? extra : undefined;
}

export function withExtra<T extends object>(known: T, extra: Extra | undefined): Record<string, unknown> {
  return extra ? { ...extra, ...known } : { ...(known as Record<string, unknown>) };
}

/** A new object with no prototype, for maps whose keys come from a file (course names, unknown keys). */
export function dict<T>(): Record<string, T> {
  return Object.create(null);
}

/** Drops a UTF-8 byte order mark that an editor put at the start of a file. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function newId(): string {
  return crypto.randomUUID().toUpperCase();
}
