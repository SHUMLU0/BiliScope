import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import { resolve } from 'node:path';
import manifest from './extension/manifest.json' with { type: 'json' };
import pkg from './package.json' with { type: 'json' };

// V3.1.0 · D6：版本号单一来源 = package.json。
// UI（popup「关于」）与导出文件头（export version 修复）都读 `__APP_VERSION__`，
// 禁止在任何源码里硬编码版本字符串。
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@db': resolve(__dirname, 'src/db'),
      '@collectors': resolve(__dirname, 'src/collectors'),
      '@repositories': resolve(__dirname, 'src/repositories'),
      '@normalizers': resolve(__dirname, 'src/normalizers'),
      '@ai': resolve(__dirname, 'src/ai'),
      '@models': resolve(__dirname, 'src/models'),
      '@utils': resolve(__dirname, 'src/utils'),
      '@ui': resolve(__dirname, 'src/ui'),
      '@content': resolve(__dirname, 'src/content'),
      '@services': resolve(__dirname, 'src/services'),
    },
  },
  plugins: [react(), crx({ manifest })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/ui/popup/index.html'),
        options: resolve(__dirname, 'src/ui/options/index.html'),
        'pages/dashboard': resolve(__dirname, 'src/ui/pages/dashboard.html'),
        'pages/video-research': resolve(__dirname, 'src/ui/pages/video-research.html'),
        'pages/creator': resolve(__dirname, 'src/ui/pages/creator.html'),
        'pages/radar': resolve(__dirname, 'src/ui/pages/radar.html'),
        'pages/comment': resolve(__dirname, 'src/ui/pages/comment.html'),
        'pages/my': resolve(__dirname, 'src/ui/pages/my.html'),
        'pages/hot': resolve(__dirname, 'src/ui/pages/hot.html'),
        'pages/idea': resolve(__dirname, 'src/ui/pages/idea.html'),
        'pages/ai-history': resolve(__dirname, 'src/ui/pages/ai-history.html'),
        'pages/tasks': resolve(__dirname, 'src/ui/pages/tasks.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background' || chunkInfo.name === 'content') {
            return 'src/[name]/[name].js';
          }
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});