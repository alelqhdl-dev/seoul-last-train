import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: 'esnext' },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
  server: { port: 5173, open: false },
});
