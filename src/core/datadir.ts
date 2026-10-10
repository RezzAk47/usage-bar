// The only file names the page may use inside the data dir. Mirrored in src-tauri/src/files.rs (valid_name).
export const SETTINGS_FILE = 'settings.json';
export const ALERTS_FILE = 'usage-alerts.json';
export const HISTORY_FILE = 'usage-history.json';
export const BACKOFF_FILE = 'usage-backoff.json';
export const ALLOWED_FILE = /^(settings|usage-alerts|usage-history|usage-backoff)(\.broken-[0-9a-z-]{1,40})?\.json$/;
