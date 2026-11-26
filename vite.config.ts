import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `--mode artifact` inlines all JS/CSS into one index.html so the build can be
// hosted as a single page; bundled data packs stay beside it in /packs.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'artifact' ? [viteSingleFile()] : [],
  build: {
    target: 'es2022',
    outDir: mode === 'artifact' ? 'dist-artifact' : 'dist',
    chunkSizeWarningLimit: 4000,
  },
}));
