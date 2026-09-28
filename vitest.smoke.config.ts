/**
 * 真实 API smoke test 专用配置（P1-10）。
 *
 * 常规 `pnpm test`（vitest.config.ts）已把 tests/smoke/** 排除，CI 因此完全离线、
 * 结果确定。这个配置只在需要验证「真实 B 站链路还活着」时手动跑：
 *
 *   pnpm test:smoke
 *
 * 注意：会真实访问 api.bilibili.com，可能因 IP 风控返回 -352 / 412，
 * 这是 B 站侧的限流，不是测试失败；测试只对「签名/结构性错误」做断言。
 */

import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
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
    environment: 'node',
    include: ['tests/smoke/**/*.{test,spec}.ts'],
    testTimeout: 30_000,
  },
});
