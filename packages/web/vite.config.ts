import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "path";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@strabon/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        // Variables et mixins globaux importés dans tous les composants
        additionalData: `@use "@/assets/scss/variables" as *;`,
      },
    },
  },
  server: {
    port: 5173,
    cors: true, // Permet à Fastify (:3000) de charger les assets Vite
    proxy: {
      // API JSON
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      // CSS/assets publics servis par Fastify
      "/public": { target: "http://localhost:3000", changeOrigin: true },
      // Pages HTML rendues par Fastify (Eta)
      "/admin": { target: "http://localhost:3000", changeOrigin: true },
      "/sites": { target: "http://localhost:3000", changeOrigin: true },
      "/polities": { target: "http://localhost:3000", changeOrigin: true },
      "/cultures": { target: "http://localhost:3000", changeOrigin: true },
      "/about": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: "index.html",
        admin: "admin.html",
      },
    },
  },
});
