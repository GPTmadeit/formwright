// Desktop (Tauri) and browser implementations of the few OS services we need.

import type { AgentSettings } from "./ai/agent";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

const SETTINGS_KEY = "formwright.settings";
export const DEFAULT_SETTINGS: AgentSettings = {
  provider: "anthropic",
  apiKey: "",
  model: "claude-opus-5-5",
  effort: "medium",
  localURL: "http://localhost:11434",
  localModel: "qwen3.5:4b",
  localThinking: false,
};

/** fetch for local model servers. On desktop it goes through Rust, so CORS never applies. */
export const localFetch: typeof fetch = async (input, init) => {
  if (!isTauri) return fetch(input, init);
  const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
  return tauriFetch(input, init);
};

export async function loadSettings(): Promise<AgentSettings> {
  try {
    const raw = isTauri ? await invoke<string | null>("load_settings") : localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(s: AgentSettings): Promise<void> {
  const raw = JSON.stringify(s);
  if (isTauri) await invoke("save_settings", { json: raw });
  else
    try {
      localStorage.setItem(SETTINGS_KEY, raw);
    } catch {
      /* private mode: settings last for this session only */
    }
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Asks where to save and writes the file. Returns false if cancelled. */
export async function saveFile(defaultName: string, data: Uint8Array | string, filter: FileFilter): Promise<boolean> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: defaultName, filters: [filter] });
    if (!path) return false;
    await invoke("write_file", { path, dataB64: toBase64(bytes) });
    return true;
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  const a = document.createElement("a");
  a.href = url;
  a.download = defaultName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/** Asks for a file and returns its text, or null if cancelled. */
export async function openTextFile(filter: FileFilter): Promise<{ name: string; text: string } | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ multiple: false, directory: false, filters: [filter] });
    if (!path || Array.isArray(path)) return null;
    const text = await invoke<string>("read_text_file", { path });
    return { name: path.split(/[\\/]/).pop() ?? path, text };
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = filter.extensions.map((e) => `.${e}`).join(",");
    input.onchange = async () => {
      const f = input.files?.[0];
      resolve(f ? { name: f.name, text: await f.text() } : null);
    };
    input.click();
  });
}

export interface UpdateInfo {
  version: string;
  /** Desktop: download, verify, install and restart. Android: open the APK download. */
  install(): Promise<void>;
}

const REPO = "GPTmadeit/formwright";
const isAndroid = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

/** Where this copy is running. The web version is always the latest deploy. */
export const platform: "desktop" | "android" | "web" = isTauri ? (isAndroid ? "android" : "desktop") : "web";

function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** Android can't self-install, so find a newer APK on GitHub and let the system install it. */
async function checkAndroidUpdate(): Promise<UpdateInfo | null> {
  const { getVersion } = await import("@tauri-apps/api/app");
  const current = await getVersion();
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) return null;
  const rel = (await res.json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] };
  const apk = rel.assets.find((a) => a.name.endsWith(".apk"));
  if (!apk || !isNewer(rel.tag_name, current)) return null;
  return {
    version: rel.tag_name.replace(/^v/, ""),
    async install() {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(apk.browser_download_url);
    },
  };
}

/** Checks GitHub releases for a newer build of the app. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    if (platform === "web") return null;
    if (platform === "android") return await checkAndroidUpdate();
    const version = await invoke<string | null>("update_check");
    return version ? { version, install: () => invoke("update_install") } : null;
  } catch (err) {
    console.warn("update check failed", err);
    return null;
  }
}

/** The running version, for the settings dialog. */
export async function appVersion(): Promise<string> {
  if (!isTauri) return __APP_VERSION__;
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

// --- local AI (desktop) ----------------------------------------------------------

export interface LocalAiStatus {
  running: boolean;
  installed: boolean;
  managed: boolean;
  version: string | null;
  models: { name: string; size: number }[];
  ramGb: number;
  gpu: string | null;
  url: string;
}

export interface LocalAiProgress {
  stage: "engine" | "model";
  status: string;
  done: number;
  total: number;
}

/** One-click install and management of local models. Desktop only. */
export const localAI = {
  available: platform === "desktop",
  status: () => invoke<LocalAiStatus>("local_ai_status"),
  /** Installs the engine if this computer has none. */
  install: () => invoke<void>("local_ai_install"),
  /** Starts the engine if it isn't running. */
  start: () => invoke<void>("local_ai_start"),
  pull: (model: string) => invoke<void>("local_ai_pull", { model }),
  remove: (model: string) => invoke<void>("local_ai_remove", { model }),
  cancel: () => invoke<void>("local_ai_cancel"),
  async onProgress(fn: (p: LocalAiProgress) => void): Promise<() => void> {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<LocalAiProgress>("local-ai-progress", (e) => fn(e.payload));
  },
};
