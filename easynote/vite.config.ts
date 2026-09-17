import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';

const versions = JSON.parse(readFileSync(new URL('../versions.json', import.meta.url), 'utf8')) as {
  easynote: string;
};

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        id: '/',
        name: 'EasyNote',
        short_name: 'EasyNote',
        description: '自托管 Markdown 图片笔记',
        lang: 'zh-CN',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#3361cc',
        categories: ['productivity'],
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: [
          '**/*.{html,css,svg}',
          'registerSW.js',
          'manifest.webmanifest',
          'assets/index-*.js',
          'assets/editor-*.js',
          'assets/markdown-*.js',
        ],
        runtimeCaching: [{
          urlPattern: /\/(?:assets\/(?:pdfmake|pdfjs|pdf\.worker)[^/]*\.(?:js|mjs)|fonts\/NotoSansSC-(?:Regular|Bold)\.otf)$/,
          handler: 'CacheFirst',
          options: {
            cacheName: 'easynote-pdf-v1',
            cacheableResponse: { statuses: [0, 200] },
          },
        }],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  define: {
    __EASYNOTE_VERSION__: JSON.stringify(versions.easynote),
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8791',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (outgoing, incoming) => {
            if (incoming.headers.origin === `http://${incoming.headers.host}`) {
              outgoing.setHeader('Origin', 'http://127.0.0.1:8791');
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist/client',
    // Mermaid's ELK layout engine is a lazy-loaded optional chunk (~1.5 MB).
    // Keep Vite's warning useful for application chunks while allowing this
    // intentional async vendor dependency.
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/@codemirror/') || id.includes('/@lezer/')) return 'editor';
          if (id.includes('/markdown-it/') || id.includes('/dompurify/')) return 'markdown';
          if (id.includes('/pdfjs-dist/')) return 'pdfjs';
          if (id.includes('/pdfmake/') || id.includes('/html-to-pdfmake/')) return 'pdfmake';
        },
      },
    },
  },
});
