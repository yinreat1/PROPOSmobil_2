import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({
  base: '/',
  plugins: [react(), VitePWA({ registerType:'autoUpdate', includeAssets:['favicon.svg'], manifest:{name:'Pro POS Mobil',short_name:'Pro POS',description:'Pro POS müşteri, stok ve ürün yönetimi',theme_color:'#0f766e',background_color:'#f1f5f9',display:'standalone',orientation:'portrait',start_url:'/',icons:[{src:'/icon-192.png',sizes:'192x192',type:'image/png'},{src:'/icon-512.png',sizes:'512x512',type:'image/png'},{src:'/icon-512.png',sizes:'512x512',type:'image/png',purpose:'maskable'}]}, workbox:{globPatterns:['**/*.{js,css,html,svg,png,ico}'],maximumFileSizeToCacheInBytes:5*1024*1024}})],
  resolve:{alias:{'@':fileURLToPath(new URL('./src',import.meta.url))}},
});
