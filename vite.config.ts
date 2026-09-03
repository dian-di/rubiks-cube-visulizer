import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    babel({
      include: /\.tsx$/,
      presets: [reactCompilerPreset()],
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
