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
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/ui/**/*.tsx'],
    },
  },
});