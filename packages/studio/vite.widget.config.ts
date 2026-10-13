import { defineConfig } from "vite";
import { resolve } from "node:path";
import { viteSingleFile } from "vite-plugin-singlefile";

/** The MCP Apps widget: one self-contained HTML file (scripts and styles inlined; no network inside the host's sandbox). */
export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    target: "es2022",
    chunkSizeWarningLimit: 4096,
    rollupOptions: { input: resolve(import.meta.dirname, "widget.html") }
  }
});
