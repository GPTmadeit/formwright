import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // Vite's default preview port (4173) is taken by another service on the dev machine.
  preview: { port: 4792, strictPort: true },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
  test: { environment: "node" },
});
