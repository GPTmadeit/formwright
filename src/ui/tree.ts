import { buildNode } from "../geom/kernel";
import type { Doc } from "../model/doc";
import type { SceneNode } from "../model/types";

export function renderTree(host: HTMLElement, doc: Doc, selected: Set<string>, onSelect: (id: string, additive: boolean) => void): void {
  const rows: HTMLElement[] = [];
  const walk = (n: SceneNode, depth: number) => {
    const row = document.createElement("div");
    row.className = `row${selected.has(n.id) ? " sel" : ""}`;
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-selected", String(selected.has(n.id)));
    row.style.paddingLeft = `${6 + depth * 14}px`;
    const sw = document.createElement("span");
    sw.className = `swatch${n.hole ? " hole" : ""}`;
    const col = n.type === "primitive" ? n.color : (n.color ?? doc.primitivesUnder(n.id).find((p) => !p.hole)?.color ?? "#9e9e9e");
    sw.style.background = col;
    const label = document.createElement("span");
    label.textContent = n.type === "group" ? `▾ ${n.name}` : n.name;
    row.append(sw, label);
    // Only top-level shapes are meshed on their own; check them for errors.
    if (!n.parent) {
      const err = buildNode(doc, n.id).error;
      if (err) {
        const e = document.createElement("span");
        e.className = "err";
        e.textContent = "!";
        e.title = err;
        row.append(e);
      }
    }
    row.addEventListener("click", (e) => onSelect(n.id, e.shiftKey || e.ctrlKey || e.metaKey));
    rows.push(row);
    if (n.type === "group") for (const c of doc.children(n.id)) walk(c, depth + 1);
  };
  for (const r of [...doc.roots()].reverse()) walk(r, 0);
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Nothing here yet. Add a shape or ask the assistant.";
    rows.push(empty);
  }
  host.replaceChildren(...rows);
}
