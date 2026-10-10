import { defineConfig } from 'vite';

// A fixed port and no browser launch, so `tauri dev` and the screenshot script can find the page.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  preview: { port: 4173, host: '127.0.0.1' },
  build: { target: 'es2022', sourcemap: false },
});
