// CAD tasks for comparing assistant models. Each check inspects the finished
// scene with the real geometry kernel, so a model only scores by building the
// right thing, not by saying it did.

import { buildNode, buildPrintable, unionBounds, type Bounds } from "../src/geom/kernel";
import type { Doc } from "../src/model/doc";

export interface Check {
  label: string;
  pass: boolean;
  detail: string;
}

export interface Task {
  id: string;
  prompt: string;
  check(doc: Doc): Check[];
}

function sceneBounds(doc: Doc): Bounds | null {
  return unionBounds(doc.roots().filter((r) => !r.hole).map((r) => buildNode(doc, r.id).bounds));
}

function size(b: Bounds): [number, number, number] {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

function volume(doc: Doc): number {
  return doc
    .roots()
    .filter((r) => !r.hole)
    .reduce((v, r) => v + buildNode(doc, r.id).volume, 0);
}

const near = (label: string, got: number, want: number, tol: number): Check => ({
  label,
  pass: Math.abs(got - want) <= tol,
  detail: `${got.toFixed(1)} (want ${want} ± ${tol})`,
});

/** Sizes are compared sorted, so a model may lay a part along either axis. */
const dims = (label: string, got: [number, number, number], want: [number, number, number], tol: number): Check => {
  const g = [...got].sort((a, b) => a - b);
  const w = [...want].sort((a, b) => a - b);
  return {
    label,
    pass: g.every((v, i) => Math.abs(v - w[i]) <= tol),
    detail: `${got.map((v) => v.toFixed(1)).join(" × ")} (want ${want.join(" × ")} ± ${tol})`,
  };
};

const onWorkplane = (b: Bounds): Check => ({
  label: "rests on the workplane",
  pass: Math.abs(b.min[2]) <= 0.6,
  detail: `lowest point z = ${b.min[2].toFixed(2)}`,
});

const noErrors = (doc: Doc): Check => {
  const bad = doc.roots().filter((r) => buildNode(doc, r.id).error);
  return { label: "no broken shapes", pass: bad.length === 0, detail: bad.map((r) => `${r.name}: ${buildNode(doc, r.id).error}`).join("; ") || "ok" };
};

function missing(label: string): Check[] {
  return [{ label, pass: false, detail: "nothing was built" }];
}

export const TASKS: Task[] = [
  {
    id: "cube",
    prompt: "Make a 40 mm cube.",
    check(doc) {
      const b = sceneBounds(doc);
      if (!b) return missing("cube exists");
      return [dims("40 mm cube", size(b), [40, 40, 40], 1), onWorkplane(b), noErrors(doc)];
    },
  },
  {
    id: "plate-hole",
    prompt: "Make a 60 × 40 × 5 mm plate with a 10 mm diameter hole through its centre.",
    check(doc) {
      const b = sceneBounds(doc);
      if (!b) return missing("plate exists");
      const v = volume(doc);
      const want = 60 * 40 * 5 - Math.PI * 25 * 5;
      return [
        dims("plate size", size(b), [60, 40, 5], 1),
        onWorkplane(b),
        { label: "hole cut through", pass: Math.abs(v - want) / want < 0.03, detail: `volume ${v.toFixed(0)} mm³ (want ≈ ${want.toFixed(0)})` },
        noErrors(doc),
      ];
    },
  },
  {
    id: "table",
    prompt:
      "Make a small table: a 100 × 60 × 4 mm top resting on four 5 × 5 mm square legs, 40 mm tall, one under each corner, standing on the workplane.",
    check(doc) {
      const b = sceneBounds(doc);
      if (!b) return missing("table exists");
      const v = volume(doc);
      const want = 100 * 60 * 4 + 4 * 5 * 5 * 40;
      const mesh = buildPrintable(doc);
      // Legs must reach the floor at all four corners: sample the footprint.
      const feet = mesh ? countFeet(mesh.positions, b) : 0;
      return [
        dims("overall size", size(b), [100, 60, 44], 1.5),
        onWorkplane(b),
        { label: "parts add up", pass: Math.abs(v - want) / want < 0.08, detail: `volume ${v.toFixed(0)} mm³ (want ≈ ${want})` },
        { label: "four legs touch the floor", pass: feet === 4, detail: `${feet} corner(s) with a leg` },
        noErrors(doc),
      ];
    },
  },
  {
    id: "mug",
    prompt:
      "Make a mug: 80 mm outside diameter, 95 mm tall, 4 mm walls and a 4 mm thick floor, open at the top, with a loop handle on one side.",
    check(doc) {
      const b = sceneBounds(doc);
      if (!b) return missing("mug exists");
      const s = size(b);
      const v = volume(doc);
      const solid = Math.PI * 40 * 40 * 95;
      return [
        near("height", s[2], 95, 3),
        { label: "handle sticks out", pass: Math.max(s[0], s[1]) > 95, detail: `widest ${Math.max(s[0], s[1]).toFixed(1)} mm (body is 80)` },
        { label: "hollow", pass: v < solid * 0.45 && v > solid * 0.1, detail: `volume ${v.toFixed(0)} mm³ (solid cylinder would be ${solid.toFixed(0)})` },
        onWorkplane(b),
        noErrors(doc),
      ];
    },
  },
];

/** How many of the bounding box's four corners have geometry touching the floor. */
function countFeet(p: Float32Array, b: Bounds): number {
  const corners = [
    [b.min[0], b.min[1]],
    [b.max[0], b.min[1]],
    [b.min[0], b.max[1]],
    [b.max[0], b.max[1]],
  ];
  const reach = Math.min(b.max[0] - b.min[0], b.max[1] - b.min[1]) * 0.2;
  let n = 0;
  for (const [cx, cy] of corners) {
    for (let i = 0; i < p.length; i += 3) {
      if (Math.abs(p[i + 2] - b.min[2]) < 0.6 && Math.hypot(p[i] - cx, p[i + 1] - cy) < reach) {
        n++;
        break;
      }
    }
  }
  return n;
}
