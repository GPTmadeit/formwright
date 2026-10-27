import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// The browser build has no Tauri to set a CSP, so it carries its own. (The
// desktop build must not: a meta CSP would also apply there and block IPC.)
const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://api.anthropic.com http://localhost:* http://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function webCsp(): Plugin {
  return {
    name: "formwright-web-csp",
    transformIndexHtml: (html) =>
      process.env.FORMWRIGHT_TARGET === "web"
        ? html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${WEB_CSP}" />`)
        : html,
  };
}

export default defineConfig({
  // Relative URLs, so the same build works in Tauri and under a GitHub Pages subpath.
  base: "./",
  clearScreen: false,
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [webCsp()],
  server: { port: 1420, strictPort: true },
  // Vite's default preview port (4173) is taken by another service on the dev machine.
  preview: { port: 4792, strictPort: true },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
  test: { environment: "node" },
});
