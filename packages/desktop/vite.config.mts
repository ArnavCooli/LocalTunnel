import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `.mts` so Vite loads this config as ESM: @tailwindcss/vite is ESM-only and
// cannot be `require`d, which is what happens with a plain `.ts` config here.
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  base: './',
  plugins: [react(), tailwindcss()],
  // shadcn generates imports as `@/components/ui/…`; the renderer lives in src/ui,
  // so that is what `@` points at.
  resolve: { alias: { '@': resolve(root, 'src/ui') } },
  build: {
    outDir: resolve(root, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome120',
  },
  server: { port: 5199 },
});
