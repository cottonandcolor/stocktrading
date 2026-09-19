import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Proxy API/SSE to local TrueForge so the branded UI can run on :5173 without CORS pain.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8790",
        changeOrigin: true,
      },
      "/finguard": {
        target: "http://127.0.0.1:8765",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/finguard/, ""),
      },
    },
  },
});
