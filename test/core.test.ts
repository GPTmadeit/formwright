import { beforeAll, describe, expect, it } from "vitest";
import { buildNode, buildPrintable, initKernel } from "../src/geom/kernel";
import { toBinarySTL } from "../src/geom/export";
import { Doc } from "../src/model/doc";
import { describeScene, runTool, type ToolHost } from "../src/ai/tools";

beforeAll(() => initKernel());

function host(doc: Doc): ToolHost {
  return { doc, snapshot: () => "", select: () => {} };
}

describe("doc", () => {
  it("adds, groups, undoes and redoes", () => {
    const d = new Doc();
    const a = d.addPrimitive({ kind: "box" });
    const b = d.addPrimitive({ kind: "cylinder", hole: true });
    expect(a.position).toEqual([0, 0, 10]);
    const g = d.group([a.id, b.id], "Plate");
    expect(d.roots().map((n) => n.id)).toEqual([g.id]);
    d.undo();
    expect(d.roots()).toHaveLength(2);
    d.redo();
    expect(d.roots()).toHaveLength(1);
  });

  it("duplicates a group deeply", () => {
    const d = new Doc();
    const a = d.addPrimitive({ kind: "box" });
    const b = d.addPrimitive({ kind: "sphere" });
    const g = d.group([a.id, b.id]);
    const c = d.duplicate(g.id, [50, 0, 0]);
    expect(d.children(c.id)).toHaveLength(2);
    expect(d.primitivesUnder(c.id).every((p) => p.position[0] === 50)).toBe(true);
  });

  it("rolls back a failing transaction", () => {
    const d = new Doc();
    const g = d.group([d.addPrimitive({ kind: "box" }).id, d.addPrimitive({ kind: "box" }).id]);
    expect(() => d.update(g.id, { position: [1, 2, 3] })).toThrow();
    expect(d.roots()).toHaveLength(1);
  });
});

describe("kernel", () => {
  it("builds every primitive kind with a sensible bounding box", () => {
    const d = new Doc();
    for (const kind of ["box", "cylinder", "cone", "sphere", "torus", "wedge", "tube", "polygon", "revolve"] as const) {
      const n = d.addPrimitive({ kind, position: [5, -5, 7] });
      const b = buildNode(d, n.id);
      expect(b.error, kind).toBeNull();
      const c = [0, 1, 2].map((i) => (b.bounds!.min[i] + b.bounds!.max[i]) / 2);
      expect(c[0]).toBeCloseTo(5, 3);
      expect(c[1]).toBeCloseTo(-5, 3);
      expect(c[2]).toBeCloseTo(7, 3);
    }
  });

  it("subtracts grouped holes", () => {
    const d = new Doc();
    const box = d.addPrimitive({ kind: "box", params: { width: 20, depth: 20, height: 20 } });
    const hole = d.addPrimitive({ kind: "cylinder", params: { radius: 5, height: 30 }, position: [0, 0, 10], hole: true });
    const g = d.group([box.id, hole.id]);
    const v = buildNode(d, g.id).volume;
    expect(v).toBeGreaterThan(8000 - Math.PI * 25 * 20 - 30);
    expect(v).toBeLessThan(8000 - Math.PI * 25 * 20 + 30);
  });

  it("applies rotations X then Y then Z", () => {
    const d = new Doc();
    // A tall thin box laid along Y by rotating 90° about X.
    const n = d.addPrimitive({ kind: "box", params: { width: 2, depth: 2, height: 40 }, rotation: [90, 0, 0] });
    const b = buildNode(d, n.id).bounds!;
    expect(b.max[1] - b.min[1]).toBeCloseTo(40, 3);
    // Then 90° about Z swings it onto X.
    d.update(n.id, { rotation: [90, 0, 90] });
    const b2 = buildNode(d, n.id).bounds!;
    expect(b2.max[0] - b2.min[0]).toBeCloseTo(40, 3);
  });

  it("exports a printable STL", () => {
    const d = new Doc();
    d.addPrimitive({ kind: "sphere" });
    const stl = toBinarySTL(buildPrintable(d)!);
    const tris = new DataView(stl.buffer).getUint32(80, true);
    expect(stl.byteLength).toBe(84 + tris * 50);
    expect(tris).toBeGreaterThan(100);
  });

  it("reports bad dimensions instead of crashing", () => {
    const d = new Doc();
    const n = d.addPrimitive({ kind: "tube", params: { radius: 5, inner_radius: 8 } });
    expect(buildNode(d, n.id).error).toMatch(/inner_radius/);
  });
});

describe("ai tools", () => {
  it("builds a mug the way the model would", () => {
    const d = new Doc();
    const h = host(d);
    const body = JSON.parse(runTool(h, "add_shape", { kind: "cylinder", name: "Body", radius: 40, height: 95, position: [0, 0, 47.5] }).content as string);
    const cavity = JSON.parse(runTool(h, "add_shape", { kind: "cylinder", name: "Cavity", radius: 36, height: 95, position: [0, 0, 51.5], hole: true }).content as string);
    const handle = JSON.parse(
      runTool(h, "add_shape", { kind: "torus", name: "Handle", radius: 22, minor_radius: 5, rotation: [90, 0, 0], position: [40, 0, 50] }).content as string,
    );
    const g = JSON.parse(runTool(h, "group_shapes", { ids: [body.id, cavity.id, handle.id], name: "Mug" }).content as string);
    expect(g.bounds.min[2]).toBeCloseTo(0, 3);
    expect(g.volume_mm3).toBeGreaterThan(0);
    const scene = JSON.parse(describeScene(d));
    expect(scene[0].type).toBe("group");
    expect(scene[0].children).toHaveLength(3);
  });

  it("rejects invalid input without touching the doc", () => {
    const d = new Doc();
    const h = host(d);
    expect(() => runTool(h, "add_shape", { kind: "box", position: [0, 0] })).toThrow(/position/);
    expect(() => runTool(h, "add_shape", { kind: "tube", radius: 5, inner_radius: 9, position: [0, 0, 0] })).toThrow(/inner_radius/);
    expect(d.all()).toHaveLength(0);
    const n = d.addPrimitive({ kind: "tube" });
    expect(() => runTool(h, "update_shape", { id: n.id, inner_radius: 50 })).toThrow();
    expect((d.get(n.id) as { params: { inner_radius: number } }).params.inner_radius).toBe(7);
    expect(d.canRedo()).toBe(false);
  });

  it("moves, drops and rotates groups", () => {
    const d = new Doc();
    const h = host(d);
    const a = d.addPrimitive({ kind: "box", position: [0, 0, 30] });
    const b = d.addPrimitive({ kind: "box", position: [30, 0, 30] });
    const g = d.group([a.id, b.id]);
    runTool(h, "move_shapes", { ids: [g.id], drop_to_workplane: true, center_to: [0, 0, 50] });
    expect(buildNode(d, g.id).bounds!.min[2]).toBeCloseTo(0, 3);
    runTool(h, "rotate_shapes", { ids: [g.id], angles: [0, 0, 90] });
    const bb = buildNode(d, g.id).bounds!;
    expect(bb.max[1] - bb.min[1]).toBeCloseTo(50, 3);
    expect(bb.max[0] - bb.min[0]).toBeCloseTo(20, 3);
  });
});
