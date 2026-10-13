import { defineConfig, type Plugin, type ResolvedConfig } from "vite";
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, createReadStream, realpathSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

/** A dependency's folder (pnpm links it under this package's node_modules). */
const pkgDir = (name: string) => realpathSync(join(import.meta.dirname, "node_modules", name));
/** A dependency of a dependency: pnpm puts it next to its dependent. */
const siblingDir = (of: string, name: string) => join(realpathSync(join(import.meta.dirname, "node_modules", of)), of.startsWith("@") ? "../.." : "..", name);

/**
 * Runtimes the studio loads on first use from its own origin (never a CDN), copied out of their npm packages:
 * MediaPipe's WASM (Apache-2.0), Pyodide (MPL-2.0, unmodified), sql.js (MIT), Tesseract.js worker and core
 * (Apache-2.0). ONNX Runtime Web's WASM (MIT) for Transformers.js is emitted by the bundle itself. Model weights are downloaded once
 * from their official hosts at first use and kept in the browser's Cache API (see src/capture/models.ts).
 */
function vendorFiles(): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  const add = (dir: string, names: string[] | ((n: string) => boolean), to: string) => {
    if (!existsSync(dir)) return;
    for (const n of readdirSync(dir)) if ((Array.isArray(names) ? names.includes(n) : names(n)) && statSync(join(dir, n)).isFile()) out.push({ from: join(dir, n), to: `${to}/${n}` });
  };
  add(join(pkgDir("@mediapipe/tasks-vision"), "wasm"), ["vision_wasm_internal.js", "vision_wasm_internal.wasm", "vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.wasm"], "vendor/mediapipe");
  add(pkgDir("pyodide"), ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json", "package.json"], "vendor/pyodide");
  add(join(pkgDir("sql.js"), "dist"), ["sql-wasm-browser.wasm"], "vendor/sqljs");
  add(join(pkgDir("tesseract.js"), "dist"), ["tesseract.esm.min.js", "worker.min.js"], "vendor/tesseract");
  add(siblingDir("tesseract.js", "tesseract.js-core"), (n) => /^tesseract-core(-relaxedsimd|-simd)?-lstm\.(wasm|wasm\.js|js)$/.test(n), "vendor/tesseract");
  return out;
}

const MIME: Record<string, string> = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".zip": "application/zip" };

function vendor(): Plugin {
  let config: ResolvedConfig;
  return {
    name: "las-vendor",
    configResolved(c) {
      config = c;
    },
    configureServer(server) {
      const files = new Map(vendorFiles().map((f) => [`/${f.to}`, f.from]));
      server.middlewares.use((req, res, next) => {
        const file = files.get((req.url ?? "").split("?")[0]);
        if (!file) return next();
        res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (config.command !== "build") return;
      const outDir = resolve(config.root, config.build.outDir);
      for (const f of vendorFiles()) {
        mkdirSync(dirname(join(outDir, f.to)), { recursive: true });
        cpSync(f.from, join(outDir, f.to));
      }
    }
  };
}

/** The service worker is its own entry (sw.js at the root); its precache list is the built shell. */
function serviceWorker(): Plugin {
  return {
    name: "las-sw",
    generateBundle(_opts, bundle) {
      // the shell: everything small enough to fetch at install; big lazy runtimes are cached on first use instead
      const size = (o: (typeof bundle)[string]) => (o.type === "chunk" ? o.code.length : typeof o.source === "string" ? o.source.length : o.source.byteLength);
      const shell = Object.keys(bundle).filter((f) => f !== "sw.js" && !f.endsWith(".map") && !f.startsWith("vendor/") && size(bundle[f]) < 600_000);
      const sw = bundle["sw.js"];
      if (sw && sw.type === "chunk") sw.code = `self.__LAS_PRECACHE__=${JSON.stringify(["/", ...shell.map((f) => `/${f}`)])};self.__LAS_VERSION__=${JSON.stringify(String(Date.now()))};\n${sw.code}`;
    }
  };
}

export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  plugins: [vendor(), serviceWorker()],
  worker: { format: "es" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: { main: resolve(import.meta.dirname, "index.html"), sw: resolve(import.meta.dirname, "src/sw.ts") },
      output: { entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js") }
    }
  },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:4711", changeOrigin: false }, "/manifest.webmanifest": "http://127.0.0.1:4711" }
  }
});
