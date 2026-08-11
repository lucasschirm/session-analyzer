import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
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
  build: {
    target: 'es2021',
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 3000,
  },
  preview: {
    port: 4173,
  },
});
