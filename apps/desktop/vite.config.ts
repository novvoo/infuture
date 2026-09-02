import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: { outDir: 'dist' },
  resolve: {
    alias: {
      '@infuture/types': new URL('../../packages/types/src/index.ts', import.meta.url).pathname,
      '@infuture/rpc': new URL('../../packages/rpc/src/index.ts', import.meta.url).pathname,
    },
  },
});
