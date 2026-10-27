import { buildNode } from "../geom/kernel";
import type { Doc } from "../model/doc";
import { KIND_LABELS, PALETTE, type PrimitiveKind, type PrimitiveNode, type PrimitiveParams, type SceneNode, type Vec2, type Vec3 } from "../model/types";

export interface InspectorActions {
  group(ids: string[]): void;
  ungroup(id: string): void;
  duplicate(ids: string[]): void;
  remove(ids: string[]): void;
  drop(ids: string[]): void;
}

type NumKey = "width" | "depth" | "height" | "radius" | "top_radius" | "inner_radius" | "minor_radius" | "fillet" | "sides";
const FIELDS: Record<PrimitiveKind, [NumKey, string][]> = {
  box: [["width", "Width X"], ["depth", "Depth Y"], ["height", "Height Z"], ["fillet", "Round edges"]],
  cylinder: [["radius", "Radius"], ["height", "Height"], ["sides", "Sides"]],
  cone: [["radius", "Base radius"], ["top_radius", "Top radius"], ["height", "Height"], ["sides", "Sides"]],
  sphere: [["radius", "Radius"], ["sides", "Detail"]],
  torus: [["radius", "Ring radius"], ["minor_radius", "Thickness"], ["sides", "Detail"]],
  wedge: [["width", "Width X"], ["depth", "Depth Y"], ["height", "Height Z"]],
  tube: [["radius", "Outer radius"], ["inner_radius", "Inner radius"], ["height", "Height"], ["sides", "Sides"]],
  polygon: [["height", "Height"]],
  revolve: [["sides", "Detail"]],
};

const fmt = (v: number) => String(Math.round(v * 100) / 100);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...kids);
  return e;
}

function numField(key: string, label: string, value: number, onCommit: (v: number) => void, step = 1): HTMLElement {
  const input = el("input", { type: "number", value: fmt(value), step: String(step) });
  input.dataset.key = key;
  input.addEventListener("change", () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) onCommit(v);
    else input.value = fmt(value);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    e.stopPropagation();
  });
  return el("label", { className: "field" }, label, input);
}

function pointsText(pts: Vec2[] | undefined): string {
  return (pts ?? []).map(([a, b]) => `${fmt(a)}, ${fmt(b)}`).join("\n");
}

function parsePoints(text: string): Vec2[] | null {
  const out: Vec2[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const m = line.split(/[,\s]+/).filter(Boolean).map(Number);
    if (m.length !== 2 || !m.every(Number.isFinite)) return null;
    out.push([m[0], m[1]]);
  }
  return out.length >= 3 ? out : null;
}

export class Inspector {
  constructor(private host: HTMLElement, private doc: Doc, private actions: InspectorActions) {}

  render(ids: string[]): void {
    const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.key;
    const nodes = ids.map((id) => this.doc.get(id)).filter((n): n is SceneNode => !!n);
    this.host.hidden = nodes.length === 0;
    if (!nodes.length) return this.host.replaceChildren();
    const parts = nodes.length === 1 ? this.single(nodes[0]) : this.multi(nodes);
    this.host.replaceChildren(...parts);
    if (focusKey) {
      const again = this.host.querySelector<HTMLInputElement>(`[data-key="${focusKey}"]`);
      again?.focus();
    }
  }

  private multi(nodes: SceneNode[]): HTMLElement[] {
    const ids = nodes.map((n) => n.id);
    const sameParent = nodes.every((n) => n.parent === nodes[0].parent);
    return [
      el("div", { className: "title" }, el("strong", {}, `${nodes.length} shapes selected`)),
      el("p", { className: "hint" }, "Group them to merge solids and cut holes out."),
      el(
        "div",
        { className: "actions" },
        el("button", { className: "btn primary", textContent: "Group", title: "Ctrl G", disabled: !sameParent, onclick: () => this.actions.group(ids) }),
        el("button", { className: "btn", textContent: "Duplicate", onclick: () => this.actions.duplicate(ids) }),
        el("button", { className: "btn", textContent: "Drop to workplane", onclick: () => this.actions.drop(ids) }),
        el("button", { className: "btn danger", textContent: "Delete", onclick: () => this.actions.remove(ids) }),
      ),
    ];
  }

  private single(n: SceneNode): HTMLElement[] {
    const doc = this.doc;
    const name = el("input", { value: n.name, ariaLabel: "Name" });
    name.dataset.key = "name";
    name.addEventListener("change", () => name.value.trim() && doc.update(n.id, { name: name.value.trim() }));
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") name.blur();
      e.stopPropagation();
    });

    const solid = el("button", { className: `btn${n.hole ? "" : " on"}`, textContent: "Solid", onclick: () => doc.update(n.id, { hole: false }) });
    const hole = el("button", { className: `btn${n.hole ? " on" : ""}`, textContent: "Hole", title: "H", onclick: () => doc.update(n.id, { hole: true }) });

    const out: HTMLElement[] = [
      el("div", { className: "title" }, name),
      el("div", { className: "kind" }, n.type === "group" ? `Group of ${doc.children(n.id).length}` : KIND_LABELS[n.kind]),
      el("div", { className: "row2" }, solid, hole),
    ];

    if (!n.hole) out.push(this.colors(n));

    if (n.type === "primitive") out.push(...this.primitiveFields(n));

    const built = buildNode(doc, n.id);
    if (built.bounds) {
      const b = built.bounds;
      out.push(
        el("h3", {}, "Size"),
        el("div", { className: "hint" }, `${fmt(b.max[0] - b.min[0])} × ${fmt(b.max[1] - b.min[1])} × ${fmt(b.max[2] - b.min[2])} mm`),
      );
    }
    if (built.error) out.push(el("div", { className: "error" }, built.error));

    const ids = [n.id];
    out.push(
      el(
        "div",
        { className: "actions" },
        n.type === "group" ? el("button", { className: "btn", textContent: "Ungroup", title: "Ctrl Shift G", onclick: () => this.actions.ungroup(n.id) }) : "",
        el("button", { className: "btn", textContent: "Duplicate", title: "Ctrl D", onclick: () => this.actions.duplicate(ids) }),
        el("button", { className: "btn", textContent: "Drop", title: "Rest on the workplane (D)", onclick: () => this.actions.drop(ids) }),
        el("button", { className: "btn danger", textContent: "Delete", title: "Del", onclick: () => this.actions.remove(ids) }),
      ),
    );
    return out;
  }

  private colors(n: SceneNode): HTMLElement {
    const current = n.type === "primitive" ? n.color : n.color;
    const wrap = el("div", { className: "swatches" });
    for (const c of PALETTE) {
      const b = el("button", { className: current?.toLowerCase() === c ? "on" : "", title: c, onclick: () => this.doc.update(n.id, { color: c }) });
      b.style.background = c;
      wrap.append(b);
    }
    const custom = el("input", { type: "color", value: current ?? "#9e9e9e", title: "Custom colour" });
    custom.addEventListener("change", () => this.doc.update(n.id, { color: custom.value }));
    wrap.append(custom);
    return el("div", {}, el("h3", {}, "Colour"), wrap);
  }

  private primitiveFields(n: PrimitiveNode): HTMLElement[] {
    const doc = this.doc;
    const setParam = (key: keyof PrimitiveParams, v: unknown) => doc.update(n.id, { params: { [key]: v } as PrimitiveParams });
    const dims = FIELDS[n.kind].map(([key, label]) =>
      numField(key, label, (n.params[key] as number | undefined) ?? 0, (v) => setParam(key, key === "sides" ? Math.round(v) : v), key === "sides" ? 1 : 0.5),
    );
    const out: HTMLElement[] = [el("h3", {}, "Dimensions (mm)"), el("div", { className: dims.length === 4 ? "fields two" : "fields" }, ...dims)];

    if (n.kind === "polygon" || n.kind === "revolve") {
      const key = n.kind === "polygon" ? "points" : "profile";
      const ta = el("textarea", { rows: 6, value: pointsText(n.params[key]), spellcheck: false });
      ta.dataset.key = key;
      ta.addEventListener("keydown", (e) => e.stopPropagation());
      ta.addEventListener("change", () => {
        const pts = parsePoints(ta.value);
        if (pts) setParam(key, pts);
        else ta.value = pointsText(n.params[key]);
      });
      out.push(el("h3", {}, n.kind === "polygon" ? "Outline (x, y per line)" : "Profile (radius, z per line)"), ta);
    }

    const vec = (key: "position" | "rotation", labels: string[], step: number) =>
      el(
        "div",
        { className: "fields" },
        ...labels.map((l, i) =>
          numField(`${key}${i}`, l, n[key][i], (v) => {
            const next = [...n[key]] as Vec3;
            next[i] = v;
            doc.update(n.id, { [key]: next });
          }, step),
        ),
      );
    out.push(el("h3", {}, "Position (centre)"), vec("position", ["X", "Y", "Z"], 1));
    out.push(el("h3", {}, "Rotation (°)"), vec("rotation", ["X", "Y", "Z"], 15));
    return out;
  }
}
