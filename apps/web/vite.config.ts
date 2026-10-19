import { defineConfig } from 'vite';
import type { Connect, Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import compression from 'compression';

function devCompression(): Plugin {
  return {
    name: 'dev-response-compression',
    apply: 'serve',
    configureServer(server) {
      const gzipMiddleware = compression({ threshold: 1024, level: 6 });
      server.middlewares.use(gzipMiddleware as unknown as Connect.NextHandleFunction);
    },
  };
}

export default defineConfig({
  plugins: [vue(), devCompression()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: { '/api': { target: 'http://server:3000', changeOrigin: true } },
  },
});
