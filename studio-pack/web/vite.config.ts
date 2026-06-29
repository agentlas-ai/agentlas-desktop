import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const GEN = fileURLToPath(new URL("./public/generated", import.meta.url));

/**
 * Local builder bridge. The Build stage chat POSTs requests here; a session
 * (Claude Code / Codex) reads `public/generated/requests.jsonl` and regenerates
 * `public/generated/app.html` + `web.html` into the folder the iframes show.
 * No separate server or popup — it lives inside the dev server.
 */
function studioBridge(): Plugin {
  return {
    name: "studio-bridge",
    configureServer(server) {
      server.middlewares.use("/__studio/request", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const data = JSON.parse(body || "{}");
            fs.mkdirSync(GEN, { recursive: true });
            fs.appendFileSync(path.join(GEN, "requests.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...data }) + "\n");
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          } catch {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false }));
          }
        });
      });
      server.middlewares.use("/__studio/manifest", (_req, res) => {
        const m = (f: string) => {
          try {
            return fs.statSync(f).mtimeMs;
          } catch {
            return 0;
          }
        };
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            app: m(path.join(GEN, "app.html")),
            web: m(path.join(GEN, "web.html")),
            data: m(fileURLToPath(new URL("./public/studio-data.json", import.meta.url))),
          })
        );
      });
    },
  };
}

// Startup Studio web surface.
export default defineConfig({
  plugins: [react(), tailwindcss(), studioBridge()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5273,
    host: true,
    // The session writes these live; the GUI re-fetches them itself. Don't let
    // vite full-reload the page on every write (that would reset run state).
    watch: { ignored: ["**/public/generated/**", "**/public/studio-data.json"] },
  },
  preview: {
    port: 4173,
    host: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
