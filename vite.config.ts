import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    port: Number(process.env.KUBEDASH_UI_PORT ?? 3100),
    strictPort: true,
    proxy: {
      '/api': process.env.KUBEDASH_API_URL ?? 'http://127.0.0.1:3001',
    },
  },
})
