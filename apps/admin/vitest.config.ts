import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.ts'],
    // 4 个 worker 并行：26 个测试文件串行时每个都要各建一次 happy-dom，
    // 并行后墙钟时间约降到 1/4。上限压在 4 而不是默认的 CPU 数，
    // 是为了控制 happy-dom 实例的常驻内存。
    maxWorkers: 4,
  },
});
