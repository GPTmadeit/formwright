import "./styles.css";
import wasmUrl from "manifold-3d/manifold.wasm?url";
import { Agent, type AgentSettings, type Effort } from "./ai/agent";
import { buildNode, buildPrintable, initKernel, unionBounds } from "./geom/kernel";
import { toBinarySTL, toOBJ } from "./geom/export";
import { Doc } from "./model/doc";
import { rotateNodes, scaleNodes } from "./model/transform";
import type { SceneDoc, Vec3 } from "./model/types";
import { checkForUpdate, loadSettings, openTextFile, saveFile, saveSettings } from "./platform";
import { ChatView } from "./ui/chat";
import { Inspector } from "./ui/inspector";
import { DRAG_MIME, renderPalette, type PaletteItem } from "./ui/palette";
import { renderTree } from "./ui/tree";
import { Viewport, type GizmoMode, type ViewName } from "./view/viewport";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const AUTOSAVE_KEY = "formwright.autosave";

await initKernel(wasmUrl);

const doc = new Doc();
const viewport = new Viewport($("viewport"), doc);
let selection: string[] = [];
let settings: AgentSettings = await loadSettings();

// --- toast -------------------------------------------------------------------
let toastTimer = 0;
function toast(msg: string): void {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove("show"), 2200);
}

// --- selection ---------------------------------------------------------------
function select(ids: string[]): void {
  selection = [...new Set(ids)].filter((id) => doc.get(id));
  viewport.setSelection(selection);
  refreshPanels();
}

function toggleSelect(id: string | null, additive: boolean): void {
  if (!id) return select(additive ? selection : []);
  if (!additive) return select([id]);
  select(selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id]);
}

const inspector = new Inspector($("inspector"), doc, {
  group: (ids) => groupSelection(ids),
  ungroup: (id) => select(doc.ungroup(id)),
  duplicate: (ids) => duplicate(ids),
  remove: (ids) => {
    doc.remove(ids);
    select([]);
  },
  drop: (ids) => drop(ids),
});

function refreshPanels(): void {
  renderTree($("tree"), doc, new Set(selection), toggleSelect);
  inspector.render(selection);
  ($("undo") as HTMLButtonElement).disabled = !doc.canUndo();
  ($("redo") as HTMLButtonElement).disabled = !doc.canRedo();
}

// --- document changes --------------------------------------------------------
let autosaveTimer = 0;
doc.onChange((e) => {
  viewport.sync(e.created);
  selection = selection.filter((id) => doc.get(id));
  viewport.setSelection(selection);
  refreshPanels();
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(doc.toJSON()));
    } catch {
      /* storage unavailable: autosave is a convenience only */
    }
  }, 400);
});

// --- edit commands ------------------------------------------------------------
function groupSelection(ids = selection): void {
  if (ids.length < 2) return toast("Select two or more shapes to group");
  try {
    const g = doc.group(ids);
    const err = buildNode(doc, g.id).error;
    if (err) toast(err);
    select([g.id]);
  } catch (err) {
    toast((err as Error).message);
  }
}

function duplicate(ids = selection): void {
  if (!ids.length) return;
  const copies = doc.transact("Duplicate", "user", () => ids.map((id) => doc.duplicate(id).id));
  select(copies);
}

function drop(ids = selection): void {
  if (!ids.length) return;
  doc.transact("Drop to workplane", "user", () => {
    for (const id of ids) {
      const b = buildNode(doc, id).bounds;
      if (b && Math.abs(b.min[2]) > 1e-6) doc.translate(id, [0, 0, -b.min[2]]);
    }
  });
}

function nudge(dx: number, dy: number, dz: number): void {
  if (!selection.length) return;
  doc.transact("Nudge", "user", () => selection.forEach((id) => doc.translate(id, [dx, dy, dz])));
}

/** A free spot near the origin so new shapes don't land inside each other. */
function freeSpot(): [number, number] {
  const roots = doc.roots();
  if (!roots.length) return [0, 0];
  const b = unionBounds(roots.map((r) => buildNode(doc, r.id).bounds));
  return b ? [Math.round(b.max[0] + 20), 0] : [0, 0];
}

function addShape(item: PaletteItem, at?: [number, number]): void {
  const [x, y] = at ?? freeSpot();
  const n = doc.addPrimitive({ kind: item.kind, hole: item.hole, name: item.hole ? item.label : undefined });
  if (x || y) doc.translate(n.id, [Math.round(x), Math.round(y), 0]);
  select([n.id]);
}

renderPalette($("palette"), (item) => addShape(item));

// Drag from the palette onto the workplane.
const vpEl = $("viewport");
vpEl.addEventListener("dragover", (e) => {
  if (!e.dataTransfer?.types.includes(DRAG_MIME)) return;
  e.preventDefault();
  vpEl.classList.add("drop-target");
});
vpEl.addEventListener("dragleave", () => vpEl.classList.remove("drop-target"));
vpEl.addEventListener("drop", (e) => {
  vpEl.classList.remove("drop-target");
  const raw = e.dataTransfer?.getData(DRAG_MIME);
  if (!raw) return;
  e.preventDefault();
  addShape(JSON.parse(raw) as PaletteItem, viewport.workplanePoint(e.clientX, e.clientY) ?? undefined);
});

// --- viewport events ----------------------------------------------------------
viewport.onPick = toggleSelect;
viewport.onGizmoEdit = (e) => {
  const ids = selection;
  const pivot: Vec3 = [e.pivot.x, e.pivot.y, e.pivot.z];
  if (e.mode === "translate") {
    const d: Vec3 = [e.delta.x, e.delta.y, e.delta.z].map((v) => Math.round(v * 1000) / 1000) as Vec3;
    doc.transact("Move", "user", () => ids.forEach((id) => doc.translate(id, d)));
  } else if (e.mode === "rotate") {
    rotateNodes(doc, ids, pivot, e.rotation);
  } else {
    scaleNodes(doc, ids, pivot, [e.scale.x, e.scale.y, e.scale.z]);
  }
};

function setMode(m: GizmoMode): void {
  viewport.setGizmoMode(m);
  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
}
document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode as GizmoMode)));
document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) => b.addEventListener("click", () => viewport.setView(b.dataset.view as ViewName)));
$("fit").addEventListener("click", () => viewport.setView("iso", selection));

const snapSel = $<HTMLSelectElement>("snap");
const applySnap = () => {
  const v = parseFloat(snapSel.value);
  viewport.setSnap(v > 0 ? v : null, v > 0 ? 15 : null);
};
snapSel.addEventListener("change", applySnap);
applySnap();

$("undo").addEventListener("click", () => doc.undo());
$("redo").addEventListener("click", () => doc.redo());

// --- file menu -------------------------------------------------------------------
const fileMenu = $("file-menu");
$("file-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  fileMenu.hidden = !fileMenu.hidden;
});
document.addEventListener("click", () => (fileMenu.hidden = true));

const SCENE_FILTER = { name: "Formwright scene", extensions: ["formwright", "json"] };
async function fileAction(act: string): Promise<void> {
  try {
    if (act === "new") {
      if (doc.all().length && !confirm("Start a new scene? You can undo this.")) return;
      doc.clear();
      select([]);
    } else if (act === "open") {
      const f = await openTextFile(SCENE_FILTER);
      if (!f) return;
      doc.load(JSON.parse(f.text) as SceneDoc, true);
      select([]);
      viewport.setView("iso");
      toast(`Opened ${f.name}`);
    } else if (act === "save") {
      if (await saveFile("model.formwright", JSON.stringify(doc.toJSON(), null, 1), SCENE_FILTER)) toast("Saved");
    } else if (act === "export-stl" || act === "export-obj") {
      const mesh = buildPrintable(doc);
      if (!mesh) return toast("Nothing to export yet");
      const stl = act === "export-stl";
      const ok = await saveFile(stl ? "model.stl" : "model.obj", stl ? toBinarySTL(mesh) : toOBJ(mesh), {
        name: stl ? "STL mesh" : "OBJ mesh",
        extensions: [stl ? "stl" : "obj"],
      });
      if (ok) toast("Exported");
    }
  } catch (err) {
    toast(`Couldn't ${act.replace("-", " ")}: ${(err as Error).message}`);
  }
}
fileMenu.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) =>
  b.addEventListener("click", () => {
    fileMenu.hidden = true;
    void fileAction(b.dataset.act!);
  }),
);

// --- keyboard ----------------------------------------------------------------------
window.addEventListener("keydown", (e) => {
  if (e.target instanceof Element && e.target.closest("input, textarea, select, dialog")) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  const step = e.shiftKey ? 10 : 1;
  const handled = (() => {
    if (mod && k === "z" && !e.shiftKey) return doc.undo(), true;
    if (mod && ((k === "z" && e.shiftKey) || k === "y")) return doc.redo(), true;
    if (mod && k === "d") return duplicate(), true;
    if (mod && k === "g" && !e.shiftKey) return groupSelection(), true;
    if (mod && k === "g" && e.shiftKey) {
      const g = selection.find((id) => doc.get(id)?.type === "group");
      if (g) select(doc.ungroup(g));
      return true;
    }
    if (mod && k === "s") return void fileAction("save"), true;
    if (mod && k === "o") return void fileAction("open"), true;
    if (mod && k === "a") return select(doc.roots().map((r) => r.id)), true;
    if (mod) return false;
    if (k === "delete" || k === "backspace") {
      if (selection.length) doc.remove(selection);
      return true;
    }
    if (k === "escape") return select([]), true;
    if (k === "w") return setMode("translate"), true;
    if (k === "e") return setMode("rotate"), true;
    if (k === "r") return setMode("scale"), true;
    if (k === "f") return viewport.setView("iso", selection), true;
    if (k === "d") return drop(), true;
    if (k === "h" && selection.length) {
      const n = doc.get(selection[0]);
      if (n) doc.update(n.id, { hole: !n.hole });
      return true;
    }
    if (k === "arrowleft") return nudge(-step, 0, 0), true;
    if (k === "arrowright") return nudge(step, 0, 0), true;
    if (k === "arrowup") return nudge(0, step, 0), true;
    if (k === "arrowdown") return nudge(0, -step, 0), true;
    if (k === "pageup") return nudge(0, 0, step), true;
    if (k === "pagedown") return nudge(0, 0, -step), true;
    return false;
  })();
  if (handled) e.preventDefault();
});

// --- assistant -----------------------------------------------------------------
const chatText = $<HTMLTextAreaElement>("chat-text");
const chat = new ChatView(
  $("chat-log"),
  $("chat-status"),
  $<HTMLButtonElement>("chat-stop"),
  $<HTMLButtonElement>("chat-send"),
  chatText,
  $("usage"),
  (ids) => select(ids),
  (s) => sendChat(s),
);

const agent = new Agent(
  {
    doc,
    snapshot: (view) => viewport.snapshot(view),
    select: (ids) => select(ids),
  },
  chat,
  () => settings,
);

function sendChat(text: string): void {
  const t = text.trim();
  if (!t) return;
  if (!settings.apiKey) {
    openSettings();
    return;
  }
  chat.user(t, agent.isRunning);
  agent.send(t);
}

$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  sendChat(chatText.value);
  chatText.value = "";
});
chatText.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $<HTMLFormElement>("chat-form").requestSubmit();
  }
});
$("chat-stop").addEventListener("click", () => agent.stop());
$("chat-new").addEventListener("click", () => {
  agent.reset();
  chat.empty();
});

// --- settings ------------------------------------------------------------------
const dlg = $<HTMLDialogElement>("settings");
function openSettings(): void {
  $<HTMLInputElement>("set-key").value = settings.apiKey;
  $<HTMLSelectElement>("set-model").value = settings.model;
  $<HTMLSelectElement>("set-effort").value = settings.effort;
  dlg.showModal();
}
$("settings-btn").addEventListener("click", openSettings);
dlg.addEventListener("close", async () => {
  if (dlg.returnValue !== "ok") return;
  settings = {
    ...settings,
    apiKey: $<HTMLInputElement>("set-key").value.trim(),
    model: $<HTMLSelectElement>("set-model").value,
    effort: $<HTMLSelectElement>("set-effort").value as Effort,
  };
  try {
    await saveSettings(settings);
    toast("Settings saved");
  } catch (err) {
    toast(`Couldn't save settings: ${(err as Error).message}`);
  }
});

// --- startup -------------------------------------------------------------------
try {
  const saved = localStorage.getItem(AUTOSAVE_KEY);
  if (saved) doc.load(JSON.parse(saved) as SceneDoc);
} catch {
  /* no autosave, or unreadable: start empty */
}
viewport.sync();
refreshPanels();
viewport.setView("iso");

void checkForUpdate().then((u) => {
  if (!u) return;
  const pill = $("update-pill");
  pill.hidden = false;
  pill.textContent = `Update to ${u.version}`;
  pill.onclick = async () => {
    pill.textContent = "Updating…";
    try {
      await u.install();
    } catch (err) {
      pill.textContent = "Update failed";
      console.error(err);
    }
  };
});

// Exposed for the UI test harness.
Object.assign(window, { __formwright: { doc, viewport, agent, select } });
