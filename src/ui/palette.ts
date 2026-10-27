import { KIND_LABELS, type PrimitiveKind } from "../model/types";

// Small isometric-ish icons; cut-outs use var(--panel) so they follow the theme.
const ICONS: Record<PrimitiveKind | "hole" | "roundHole", string> = {
  box: `<path d="M17 5 29 11v13l-12 6-12-6V11z" fill="#3fa7d6"/><path d="M17 5 29 11l-12 6-12-6z" fill="#7cc6e8"/><path d="M17 17v13l12-6V11z" fill="#2b86b0"/>`,
  cylinder: `<path d="M6 10v15c0 3 5 5 11 5s11-2 11-5V10z" fill="#e8553e"/><ellipse cx="17" cy="10" rx="11" ry="5" fill="#f4907f"/>`,
  cone: `<path d="M17 4 6 26c0 3 5 5 11 5s11-2 11-5z" fill="#f2a33a"/><path d="M17 4 6 26c0 3 5 5 11 5z" fill="#f7c27a"/>`,
  sphere: `<circle cx="17" cy="17" r="12" fill="#5cb85c"/><circle cx="13" cy="13" r="5" fill="#8fd18f"/>`,
  torus: `<ellipse cx="17" cy="18" rx="13" ry="8" fill="#a05cd6"/><ellipse cx="17" cy="17" rx="5.5" ry="3" fill="var(--panel)"/><path d="M4 17c0-4 6-8 13-8s13 4 13 8" fill="none" stroke="#c597ea" stroke-width="2"/>`,
  wedge: `<path d="M5 25 17 31l12-6V12z" fill="#5865f2"/><path d="M5 25 29 12l-12-6L5 19z" fill="#8a94f7"/><path d="M5 19v6l12 6" fill="#3d48c4"/>`,
  tube: `<path d="M6 10v15c0 3 5 5 11 5s11-2 11-5V10z" fill="#8d6e63"/><ellipse cx="17" cy="10" rx="11" ry="5" fill="#b39187"/><ellipse cx="17" cy="10" rx="6" ry="2.6" fill="var(--panel)"/>`,
  polygon: `<path d="M17 4 29 12l-4 15H9L5 12z" fill="#e87fb4"/><path d="M17 4 29 12l-12 3-12-3z" fill="#f2b0d2"/>`,
  revolve: `<path d="M11 6h12l-2 6c4 2 6 6 6 10 0 5-4 8-10 8s-10-3-10-8c0-4 2-8 6-10z" fill="#f5d547"/><ellipse cx="17" cy="6" rx="6" ry="2" fill="#faeaa0"/>`,
  hole: `<path d="M17 5 29 11v13l-12 6-12-6V11z" fill="none" stroke="#8a96a8" stroke-width="1.6" stroke-dasharray="3 2"/><path d="M5 11l12 6 12-6M17 17v13" fill="none" stroke="#8a96a8" stroke-width="1.6" stroke-dasharray="3 2"/>`,
  roundHole: `<path d="M6 10v15c0 3 5 5 11 5s11-2 11-5V10" fill="none" stroke="#8a96a8" stroke-width="1.6" stroke-dasharray="3 2"/><ellipse cx="17" cy="10" rx="11" ry="5" fill="none" stroke="#8a96a8" stroke-width="1.6" stroke-dasharray="3 2"/>`,
};

export interface PaletteItem {
  kind: PrimitiveKind;
  hole: boolean;
  label: string;
}

const ITEMS: PaletteItem[] = [
  ...(["box", "cylinder", "sphere", "cone", "torus", "wedge", "tube", "polygon", "revolve"] as PrimitiveKind[]).map((kind) => ({
    kind,
    hole: false,
    label: KIND_LABELS[kind],
  })),
  { kind: "box", hole: true, label: "Box hole" },
  { kind: "cylinder", hole: true, label: "Round hole" },
];

export const DRAG_MIME = "application/x-formwright-shape";

export function renderPalette(host: HTMLElement, onAdd: (item: PaletteItem) => void): void {
  host.replaceChildren(
    ...ITEMS.map((item) => {
      const b = document.createElement("button");
      b.className = `shape-btn${item.hole ? " hole" : ""}`;
      b.draggable = true;
      b.title = item.hole ? `${item.label}: cuts away from shapes it is grouped with` : `Add a ${item.label.toLowerCase()}`;
      const icon = item.hole ? (item.kind === "box" ? ICONS.hole : ICONS.roundHole) : ICONS[item.kind];
      b.innerHTML = `<svg viewBox="0 0 34 34" aria-hidden="true">${icon}</svg><span></span>`;
      b.querySelector("span")!.textContent = item.label;
      b.addEventListener("click", () => onAdd(item));
      b.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData(DRAG_MIME, JSON.stringify(item));
        e.dataTransfer!.effectAllowed = "copy";
      });
      return b;
    }),
  );
}
