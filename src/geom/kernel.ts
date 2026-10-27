import Module, { type Manifold as ManifoldT, type ManifoldToplevel } from "manifold-3d";
import type { Doc } from "../model/doc";
import type { PrimitiveNode, SceneNode, Vec2, Vec3 } from "../model/types";

let wasm: ManifoldToplevel | null = null;

/** Loads the WASM kernel. `wasmUrl` is needed in the browser (Vite asset URL). */
export async function initKernel(wasmUrl?: string): Promise<void> {
  if (wasm) return;
  wasm = await Module(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
  wasm.setup();
}

function k(): ManifoldToplevel {
  if (!wasm) throw new Error("geometry kernel not initialised");
  return wasm;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export interface MeshData {
  positions: Float32Array; // xyz per vertex
  indices: Uint32Array;
}

/** Collects intermediate WASM objects so they are freed in one place. */
class Scope {
  private items: { delete(): void }[] = [];
  keep<T extends { delete(): void }>(m: T): T {
    this.items.push(m);
    return m;
  }
  free(except?: unknown): void {
    for (const m of this.items) if (m !== except) m.delete();
    this.items = [];
  }
}

function positive(name: string, v: number | undefined, kind: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new Error(`${kind} needs a positive ${name} (got ${v})`);
  }
  return v;
}

function segments(v: number | undefined): number {
  return Math.max(3, Math.min(256, Math.round(v ?? 64)));
}

function cleanPolygon(pts: Vec2[] | undefined, what: string): Vec2[] {
  if (!Array.isArray(pts) || pts.length < 3) throw new Error(`${what} needs at least 3 points`);
  for (const p of pts) {
    if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)) {
      throw new Error(`${what} points must be [x, y] number pairs`);
    }
  }
  // Manifold wants counter-clockwise outlines; accept either winding.
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    area += x1 * y2 - x2 * y1;
  }
  if (Math.abs(area) < 1e-9) throw new Error(`${what} outline has zero area`);
  return area < 0 ? [...pts].reverse() : pts;
}

/** Builds the primitive in its local frame (not yet centred or placed). */
function rawPrimitive(n: PrimitiveNode, s: Scope): ManifoldT {
  const { Manifold, CrossSection } = k();
  const p = n.params;
  const kind = n.kind;
  switch (kind) {
    case "box": {
      const w = positive("width", p.width, kind);
      const d = positive("depth", p.depth, kind);
      const h = positive("height", p.height, kind);
      const f = Math.min(Math.max(p.fillet ?? 0, 0), Math.min(w, d, h) / 2 - 1e-3);
      if (f <= 0.01) return s.keep(Manifold.cube([w, d, h], true));
      const ball = s.keep(Manifold.sphere(f, 24));
      const corners: ManifoldT[] = [];
      for (const x of [-1, 1])
        for (const y of [-1, 1])
          for (const z of [-1, 1])
            corners.push(s.keep(ball.translate([x * (w / 2 - f), y * (d / 2 - f), z * (h / 2 - f)])));
      return s.keep(Manifold.hull(corners));
    }
    case "cylinder": {
      const r = positive("radius", p.radius, kind);
      const h = positive("height", p.height, kind);
      return s.keep(Manifold.cylinder(h, r, r, segments(p.sides), true));
    }
    case "cone": {
      const r = positive("radius", p.radius, kind);
      const h = positive("height", p.height, kind);
      const top = Math.max(0, p.top_radius ?? 0);
      return s.keep(Manifold.cylinder(h, r, top, segments(p.sides), true));
    }
    case "sphere": {
      const r = positive("radius", p.radius, kind);
      return s.keep(Manifold.sphere(r, segments(p.sides)));
    }
    case "torus": {
      const R = positive("radius", p.radius, kind);
      const r = positive("minor_radius", p.minor_radius, kind);
      if (r >= R) throw new Error("torus minor_radius must be smaller than radius");
      const ring = s.keep(s.keep(CrossSection.circle(r, Math.max(12, segments(p.sides) / 2))).translate([R, 0]));
      return s.keep(Manifold.revolve(ring, segments(p.sides)));
    }
    case "wedge": {
      // A ramp: full height at the back (+Y), sloping down to the front (-Y).
      const w = positive("width", p.width, kind) / 2;
      const d = positive("depth", p.depth, kind) / 2;
      const h = positive("height", p.height, kind);
      return s.keep(
        Manifold.hull([
          [-w, -d, 0],
          [w, -d, 0],
          [-w, d, 0],
          [w, d, 0],
          [-w, d, h],
          [w, d, h],
        ]),
      );
    }
    case "tube": {
      const r = positive("radius", p.radius, kind);
      const ri = positive("inner_radius", p.inner_radius, kind);
      const h = positive("height", p.height, kind);
      if (ri >= r) throw new Error("tube inner_radius must be smaller than radius");
      const seg = segments(p.sides);
      const outer = s.keep(Manifold.cylinder(h, r, r, seg, true));
      const inner = s.keep(Manifold.cylinder(h + 2, ri, ri, seg, true));
      return s.keep(outer.subtract(inner));
    }
    case "polygon": {
      const h = positive("height", p.height, kind);
      const cs = s.keep(CrossSection.ofPolygons([cleanPolygon(p.points, "polygon")]));
      return s.keep(Manifold.extrude(cs, h));
    }
    case "revolve": {
      const prof = cleanPolygon(p.profile, "revolve profile");
      if (prof.some(([r]) => r < 0)) throw new Error("revolve profile radii must be >= 0");
      const cs = s.keep(CrossSection.ofPolygons([prof]));
      return s.keep(Manifold.revolve(cs, segments(p.sides)));
    }
  }
}

/** The primitive placed in world space. */
function placedPrimitive(n: PrimitiveNode, s: Scope): ManifoldT {
  const raw = rawPrimitive(n, s);
  if (raw.isEmpty()) throw new Error(`${n.name} has no volume`);
  const b = raw.boundingBox();
  const c: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const centred = s.keep(raw.translate([-c[0], -c[1], -c[2]]));
  const rotated = s.keep(centred.rotate(n.rotation));
  return s.keep(rotated.translate(n.position));
}

/**
 * The solid a node contributes. For a group: union of its solid children
 * minus the union of its hole children. Returns null for an empty group.
 */
function nodeSolid(doc: Doc, node: SceneNode, s: Scope): ManifoldT | null {
  if (node.type === "primitive") return placedPrimitive(node, s);
  const { Manifold } = k();
  const solids: ManifoldT[] = [];
  const holes: ManifoldT[] = [];
  for (const c of doc.children(node.id)) {
    const m = nodeSolid(doc, c, s);
    if (m) (c.hole ? holes : solids).push(m);
  }
  if (solids.length === 0) return holes.length ? s.keep(Manifold.union(holes)) : null;
  const body = solids.length === 1 ? solids[0] : s.keep(Manifold.union(solids));
  if (holes.length === 0) return body;
  const cut = holes.length === 1 ? holes[0] : s.keep(Manifold.union(holes));
  return s.keep(body.subtract(cut));
}

function toMeshData(m: ManifoldT): MeshData {
  const mesh = m.getMesh();
  const np = mesh.numProp;
  const nv = mesh.vertProperties.length / np;
  const positions = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    positions[i * 3] = mesh.vertProperties[i * np];
    positions[i * 3 + 1] = mesh.vertProperties[i * np + 1];
    positions[i * 3 + 2] = mesh.vertProperties[i * np + 2];
  }
  return { positions, indices: new Uint32Array(mesh.triVerts) };
}

export interface BuiltNode {
  mesh: MeshData | null;
  bounds: Bounds | null;
  volume: number;
  error: string | null;
}

const cache = new Map<string, BuiltNode>();

function cacheKey(doc: Doc, id: string): string {
  return JSON.stringify(doc.subtree(id).map((n) => [n.id, n.parent, n.type === "primitive" ? [n.kind, n.params, n.position, n.rotation, n.hole] : n.hole]));
}

/** Meshes a node (a top-level shape or group, or any child for highlighting). */
export function buildNode(doc: Doc, id: string): BuiltNode {
  const node = doc.get(id);
  if (!node) return { mesh: null, bounds: null, volume: 0, error: "missing" };
  const key = cacheKey(doc, id);
  const hit = cache.get(key);
  if (hit) return hit;
  const s = new Scope();
  let built: BuiltNode;
  try {
    const m = nodeSolid(doc, node, s);
    if (!m || m.isEmpty()) built = { mesh: null, bounds: null, volume: 0, error: m ? "result is empty" : null };
    else {
      const b = m.boundingBox();
      built = { mesh: toMeshData(m), bounds: { min: [...b.min] as Vec3, max: [...b.max] as Vec3 }, volume: m.volume(), error: null };
    }
  } catch (err) {
    built = { mesh: null, bounds: null, volume: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    s.free();
  }
  if (cache.size > 2000) cache.clear();
  cache.set(key, built);
  return built;
}

/** Throws with a readable message if the primitive cannot be built. */
export function validatePrimitive(n: PrimitiveNode): void {
  const s = new Scope();
  try {
    placedPrimitive(n, s);
  } finally {
    s.free();
  }
}

/** Everything printable: all top-level solids merged (top-level holes are ignored). */
export function buildPrintable(doc: Doc): MeshData | null {
  const { Manifold } = k();
  const s = new Scope();
  try {
    const parts: ManifoldT[] = [];
    for (const r of doc.roots()) {
      if (r.hole) continue;
      const m = nodeSolid(doc, r, s);
      if (m && !m.isEmpty()) parts.push(m);
    }
    if (!parts.length) return null;
    const all = parts.length === 1 ? parts[0] : s.keep(Manifold.union(parts));
    return toMeshData(all);
  } finally {
    s.free();
  }
}

export function unionBounds(list: (Bounds | null)[]): Bounds | null {
  let out: Bounds | null = null;
  for (const b of list) {
    if (!b) continue;
    if (!out) out = { min: [...b.min] as Vec3, max: [...b.max] as Vec3 };
    else
      for (let i = 0; i < 3; i++) {
        out.min[i] = Math.min(out.min[i], b.min[i]);
        out.max[i] = Math.max(out.max[i], b.max[i]);
      }
  }
  return out;
}
