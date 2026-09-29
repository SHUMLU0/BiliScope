import { defineConfig, configDefaults } from 'vitest/config';
import { resolve } from 'node:path';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  // V3.1.0 · D6：与 vite.config.ts 保持一致 —— 测试环境同样注入 __APP_VERSION__，
  // 让「版本号单一来源」在源码与测试里都成立。
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
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    // P1-10：真实网络 smoke test 不在常规测试里跑（否则 CI 每次都打真实 B 站接口）。
    // 需要时用 `pnpm test:smoke`（见 vitest.smoke.config.ts）。
    exclude: [...configDefaults.exclude, 'tests/smoke/**'],
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/ui/**/*.tsx'],
    },
  },
});