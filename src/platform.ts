// Desktop (Tauri) and browser implementations of the few OS services we need.

import type { AgentSettings } from "./ai/agent";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

const SETTINGS_KEY = "formwright.settings";
export const DEFAULT_SETTINGS: AgentSettings = { apiKey: "", model: "claude-opus-5-5", effort: "medium" };

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
  install(): Promise<void>;
}

/** Checks GitHub releases for a newer signed build (desktop only). */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri) return null;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      async install() {
        await update.downloadAndInstall();
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      },
    };
  } catch (err) {
    console.warn("update check failed", err);
    return null;
  }
}
