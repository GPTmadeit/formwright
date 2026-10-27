// End-to-end UI test: builds the app, serves it, drives headless Chromium over
// CDP, and runs the assistant against the scripted mock API.
//   node test/ui/run.mjs [screenshot-dir]
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockApi } from "./mock-api.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const shots = path.resolve(process.argv[2] ?? path.join(root, "test/ui/out"));
fs.mkdirSync(shots, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const procs = [];
const cleanup = () => procs.forEach((p) => p.kill("SIGKILL"));
process.on("exit", cleanup);

execFileSync("npx", ["vite", "build", "--logLevel", "error"], { cwd: root, stdio: "inherit" });
// Serve the build with the desktop app's real CSP, so anything it would block
// (WASM, API calls) fails here too. Only the API origin is swapped for the mock.
const conf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
const csp = conf.app.security.csp.replace("https://api.anthropic.com", "http://127.0.0.1:8791");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png" };
http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const file = path.join(root, "dist", url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
    if (!file.startsWith(path.join(root, "dist")) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "content-security-policy": csp });
    fs.createReadStream(file).pipe(res);
  })
  .listen(4791, "127.0.0.1");
const { requests } = await startMockApi(8791);

const chrome = process.env.CHROME ?? "chromium";
const profile = fs.mkdtempSync(path.join(shots, "profile-"));
procs.push(
  spawn(chrome, [
    "--headless=new",
    "--remote-debugging-port=9791",
    `--user-data-dir=${profile}`,
    "--window-size=1440,900",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--no-first-run",
    "about:blank",
  ], { stdio: "ignore" }),
);

async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${errors.length ? `\npage errors: ${errors.join(" | ")}` : ""}`);
    await sleep(100);
  }
}

await waitFor(() => fetch("http://127.0.0.1:4791/").then((r) => r.ok), "static server");
const targets = await waitFor(() => fetch("http://127.0.0.1:9791/json").then((r) => r.json()), "chromium");
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();

ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
});
const cdp = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expr) => {
  const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${expr.slice(0, 60)}…: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
const shot = async (name) => {
  const { data } = await cdp("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
};

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};

await cdp("Runtime.enable");
await cdp("Page.enable");
await cdp("Page.navigate", { url: "http://127.0.0.1:4791/" });
await waitFor(() => evaluate("!!window.__formwright"), "app boot");
await evaluate(`localStorage.setItem("formwright.settings", JSON.stringify({ apiKey: "test-key", model: "claude-opus-5-5", effort: "medium", baseURL: "http://127.0.0.1:8791" })); localStorage.removeItem("formwright.autosave"); true`);
await cdp("Page.reload");
await waitFor(() => evaluate("!!window.__formwright"), "app reboot");
await shot("01-empty");

// --- manual modelling -----------------------------------------------------------
await evaluate(`document.querySelector(".shape-btn").click(); true`);
check((await evaluate(`__formwright.doc.roots().length`)) === 1, "palette click adds a box");
check(!(await evaluate(`document.getElementById("inspector").hidden`)), "inspector opens for the new shape");
await evaluate(`(() => { const i = document.querySelector('#inspector [data-key="width"]'); i.value = "42"; i.dispatchEvent(new Event("change")); return true; })()`);
check((await evaluate(`__formwright.doc.roots()[0].params.width`)) === 42, "inspector edits width");
await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true })); true`);
check((await evaluate(`__formwright.doc.roots()[0].params.width`)) === 20, "ctrl+z undoes");
await evaluate(`document.querySelectorAll(".shape-btn")[10].click(); true`); // round hole
await evaluate(`__formwright.select(__formwright.doc.roots().map(r => r.id)); true`);
await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "g", ctrlKey: true })); true`);
check((await evaluate(`__formwright.doc.roots().length === 1 && __formwright.doc.roots()[0].type === "group"`)) === true, "ctrl+g groups");
await sleep(600);
await shot("02-manual-group");
await evaluate(`__formwright.doc.clear(); true`);

// --- assistant ------------------------------------------------------------------------
const send = (t) => evaluate(`(() => { const ta = document.getElementById("chat-text"); ta.value = ${JSON.stringify(t)}; document.getElementById("chat-form").requestSubmit(); return true; })()`);
await send("Make me a mounting plate with a hole");
await waitFor(() => evaluate(`__formwright.agent.isRunning`), "agent starts");
check(!(await evaluate(`document.getElementById("chat-stop").hidden`)), "stop button shows while working");
await waitFor(() => requests.length >= 2, "second request");
await shot("03-building");
await send("make it red");
check((await evaluate(`!!document.querySelector(".msg.user.queued")`)) === true, "interjection is queued while busy");
await waitFor(() => evaluate(`!__formwright.agent.isRunning`), "agent finishes", 20000);
await sleep(700);
await shot("04-done");

const r0 = requests[0].body;
check(r0.model === "claude-opus-5-5", "uses claude-opus-5-5");
check(r0.thinking?.type === "adaptive" && r0.thinking?.display === "updates", "adaptive thinking with progress updates");
check(r0.output_config?.effort === "medium", "explicit effort");
check(r0.fallbacks === "default", "server-side fallback opted in");
check(String(requests[0].headers["anthropic-beta"]).includes("thinking-display-updates-2026-08-18"), "progress-updates beta header");
check(r0.tools.every((t) => t.eager_input_streaming === true), "eager input streaming on every tool");
check(JSON.stringify(r0.messages[0].content).includes("<scene>"), "first message carries the scene");
const interjected = requests.findIndex((r) => JSON.stringify(r.body.messages.at(-1)).includes("make it red"));
check(interjected === 2, `interjection delivered at the next step (request ${interjected})`);
const snap = requests.find((r) => JSON.stringify(r.body.messages.at(-1)).includes('"type":"image"'));
check(!!snap, "view_snapshot returns an image to the model");
if (snap) {
  const img = snap.body.messages.at(-1).content.find((c) => c.type === "tool_result" && Array.isArray(c.content)).content[0].source.data;
  fs.writeFileSync(path.join(shots, "05-model-snapshot.png"), Buffer.from(img, "base64"));
  check(img.length > 5000, "snapshot image is non-trivial");
}
// History must be append-only: each request extends the previous one.
let appendOnly = true;
for (let i = 1; i < requests.length; i++) {
  const prev = JSON.stringify(requests[i - 1].body.messages);
  const cur = JSON.stringify(requests[i].body.messages.slice(0, requests[i - 1].body.messages.length));
  if (prev !== cur) appendOnly = false;
}
check(appendOnly, "conversation history is append-only");
const scene = await evaluate(`JSON.stringify(__formwright.doc.toJSON())`);
const parsed = JSON.parse(scene);
const group = parsed.nodes.find((n) => n.type === "group");
check(group?.name === "Bracket" && group.color === "#e8553e", "AI built and recoloured the group");
check((await evaluate(`document.querySelectorAll(".msg.tool:not(.err)").length`)) >= 5, "tool chips rendered");
check((await evaluate(`document.querySelector(".msg.progress")?.textContent`)) === "Starting with the base plate.", "progress notes rendered");
check((await evaluate(`document.querySelector(".msg.assistant:last-of-type strong")?.textContent`)) === "red", "markdown rendered");

// --- stop ------------------------------------------------------------------------------
await evaluate(`__formwright.agent.reset(); __formwright.doc.clear(); true`);
const before = requests.length;
await send("again");
await waitFor(() => requests.length >= before + 2, "stop-test second request");
await evaluate(`document.getElementById("chat-stop").click(); true`);
await waitFor(() => evaluate(`!__formwright.agent.isRunning`), "agent stops");
check((await evaluate(`__formwright.doc.roots().length`)) === 1, "stop leaves earlier steps in place");
await send("carry on");
await waitFor(() => requests.length >= before + 3, "request after stop");
const after = requests.at(-1).body.messages;
check(after.at(-1).role === "user" && JSON.stringify(after.at(-1)).includes("carry on"), "conversation continues after stop");
await evaluate(`__formwright.agent.stop(); true`);
await waitFor(() => evaluate(`!__formwright.agent.isRunning`), "agent stops again");

// --- narrow window (tiling window managers ignore minWidth) ---------------------------
for (const width of [940, 800]) {
  await cdp("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const fits = await evaluate(`(() => {
    const r = document.querySelector(".chat").getBoundingClientRect();
    return r.right <= innerWidth + 0.5 && document.documentElement.scrollWidth <= innerWidth;
  })()`);
  check(fits, `layout fits a ${width}px window`);
}
await shot("06-narrow");

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
console.log(failures ? `\n${failures} failing` : "\nall passed");
console.log(`screenshots: ${shots}`);
cleanup();
process.exit(failures ? 1 : 0);
