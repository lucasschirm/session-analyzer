import { defineConfig } from 'vite';
import path from 'path';

/**
 * COOP/COEP headers are required for SharedArrayBuffer, which the SQLite
 * WASM OPFS VFS depends on. Without them the app degrades to in-memory
 * storage. On GitHub Pages (where headers cannot be configured) a service
 * worker injects them instead - see public/coi-sw.js.
 */
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // Relative base so the built app works from a GitHub Pages subpath.
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@components': path.resolve(__dirname, './src/components'),
      '@pages': path.resolve(__dirname, './src/pages'),
      '@workers': path.resolve(__dirname, './src/workers'),
      '@db': path.resolve(__dirname, './src/db'),
      '@types': path.resolve(__dirname, './src/types'),
    },
  },
  worker: {
    // Workers use dynamic imports (sqlite-wasm), which require ES modules.
    format: 'es',
  },
  optimizeDeps: {
    // Keep import.meta.url-based asset resolution (sqlite3.wasm and the OPFS
    // async proxy worker) intact during development.
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 3000,
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    port: 4173,
    headers: crossOriginIsolationHeaders,
  },
});
