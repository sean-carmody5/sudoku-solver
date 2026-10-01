import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Short git SHA baked into the bundle so a device's running build is always
// identifiable (footer + console) - ends "is my phone on the old version?".
function buildId(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'dev'
  }
}

// Content hash of a shipped model. Model URLs carry it as ?v=..., because
// both the CDN (immutable, one year) and the service worker (cache-first)
// cache models by URL: without it, anyone who scanned once would keep the
// first model they downloaded, whatever was deployed after.
function modelVersion(name: string): string {
  try {
    const path = fileURLToPath(new URL(`./public/models/${name}`, import.meta.url))
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 10)
  } catch {
    return 'dev'
  }
}

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
    __MODEL_VERSIONS__: JSON.stringify({
      cnn: modelVersion('cnn-v1.onnx'),
      detect: modelVersion('detect-v1.onnx'),
      detectLive: modelVersion('detect-live.onnx'),
    }),
  },
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Sudoku Solver',
        short_name: 'Sudoku Solver',
        description: 'Scan or type any sudoku and solve it instantly - entirely in your browser.',
        theme_color: '#f4f6f9',
        background_color: '#f4f6f9',
        display: 'standalone',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // The 13MB ORT wasm and the models must NOT be precached (they would
        // download on first visit); they are cached on first scan instead.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        globIgnores: ['**/ort-*.wasm', 'models/**', 'og.png'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /ort-.*\.wasm$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'ort-wasm',
              expiration: { maxEntries: 2, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /\/models\/.*\.onnx$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'models',
              expiration: { maxEntries: 6, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
})
