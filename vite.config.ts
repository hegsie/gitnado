import { defineConfig } from 'vite';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(rootDir, 'src'),
      '@components': resolve(rootDir, 'src/components'),
      '@stores': resolve(rootDir, 'src/stores'),
      '@services': resolve(rootDir, 'src/services'),
      '@types': resolve(rootDir, 'src/types'),
      '@utils': resolve(rootDir, 'src/utils'),
      '@styles': resolve(rootDir, 'src/styles'),
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],
});
