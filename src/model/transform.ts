import * as THREE from "three";
import type { Doc } from "./doc";
import type { PrimitiveNode, PrimitiveParams, Vec2, Vec3 } from "./types";
import { degreesOf, eulerOf } from "../view/viewport";

const round = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
};
const roundVec = (v: THREE.Vector3): Vec3 => [round(v.x), round(v.y), round(v.z)];

/** Every primitive affected when the given nodes are transformed together. */
function affected(doc: Doc, ids: string[]): PrimitiveNode[] {
  const seen = new Map<string, PrimitiveNode>();
  for (const id of ids) for (const p of doc.primitivesUnder(id)) seen.set(p.id, p);
  return [...seen.values()];
}

/** Rotates the nodes by `q` about `pivot` (world space). */
export function rotateNodes(doc: Doc, ids: string[], pivot: Vec3, q: THREE.Quaternion, source: "user" | "ai" = "user", label = "Rotate"): void {
  const pv = new THREE.Vector3(...pivot);
  const items = affected(doc, ids).map((p) => {
    const pos = new THREE.Vector3(...p.position).sub(pv).applyQuaternion(q).add(pv);
    const quat = new THREE.Quaternion().setFromEuler(eulerOf(p.rotation)).premultiply(q);
    return { id: p.id, position: roundVec(pos), rotation: degreesOf(quat) };
  });
  doc.setTransforms(label, items, source);
}

/** Scales a primitive's own dimensions along its local axes. */
export function scaleParams(p: PrimitiveNode, s: Vec3): PrimitiveParams {
  const [sx, sy, sz] = s;
  const sr = (sx + sy) / 2;
  const out: PrimitiveParams = structuredClone(p.params);
  const mul = (key: keyof PrimitiveParams, f: number) => {
    const v = out[key];
    if (typeof v === "number") (out as Record<string, number>)[key] = round(v * f);
  };
  switch (p.kind) {
    case "box":
    case "wedge":
      mul("width", sx);
      mul("depth", sy);
      mul("height", sz);
      mul("fillet", Math.min(sx, sy, sz));
      break;
    case "sphere":
      mul("radius", (sx + sy + sz) / 3);
      break;
    case "torus":
      mul("radius", sr);
      mul("minor_radius", sz);
      break;
    case "polygon":
      out.points = (out.points ?? []).map(([x, y]) => [round(x * sx), round(y * sy)] as Vec2);
      mul("height", sz);
      break;
    case "revolve":
      out.profile = (out.profile ?? []).map(([r, z]) => [round(r * sr), round(z * sz)] as Vec2);
      break;
    default:
      mul("radius", sr);
      mul("top_radius", sr);
      mul("inner_radius", sr);
      mul("height", sz);
  }
  return out;
}

/**
 * Scales nodes about `pivot`. A single primitive scales per-axis in its own
 * frame; a group or multi-selection scales uniformly so shapes keep fitting.
 */
export function scaleNodes(doc: Doc, ids: string[], pivot: Vec3, s: Vec3, source: "user" | "ai" = "user"): void {
  const prims = affected(doc, ids);
  const single = ids.length === 1 && doc.get(ids[0])?.type === "primitive";
  const u = (s[0] + s[1] + s[2]) / 3;
  const factor: Vec3 = single ? s : [u, u, u];
  const pv = new THREE.Vector3(...pivot);
  const items = prims.map((p) => {
    const pos = single ? new THREE.Vector3(...p.position) : new THREE.Vector3(...p.position).sub(pv).multiplyScalar(u).add(pv);
    return { id: p.id, position: roundVec(pos), rotation: p.rotation, params: scaleParams(p, factor) };
  });
  doc.setTransforms("Scale", items, source);
}

/** Lifts or drops the nodes so their lowest point rests on z = 0. */
export function dropToWorkplane(doc: Doc, ids: string[], minZ: number, source: "user" | "ai" = "user"): void {
  if (Math.abs(minZ) < 1e-6) return;
  doc.transact("Drop to workplane", source, () => {
    for (const id of ids) doc.translate(id, [0, 0, -minZ], source);
  });
}
