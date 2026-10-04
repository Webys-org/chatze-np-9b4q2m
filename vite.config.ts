import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import devServer from '@hono/vite-dev-server'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    devServer({
      entry: 'src/server/index.ts',
      exclude: [/^\/(?!(api)\/).*/],
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname || process.cwd(), './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
  },
})
