import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    // build.externalizeDeps defaults to true: runtime deps (OpenCode SDK) stay in node_modules.
    build: {
      rolldownOptions: { input: { index: resolve('src/main/index.ts') } },
    },
  },
  preload: {
    build: {
      // Sandboxed preloads cannot be ESM; force CJS even though the package is "type": "module".
      rolldownOptions: { input: { index: resolve('src/preload/index.ts') }, output: { format: 'cjs' } },
      externalizeDeps: false,
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
    plugins: [react(), tailwindcss()],
    build: {
      rolldownOptions: { input: { index: resolve('src/renderer/index.html') } },
    },
  },
})
