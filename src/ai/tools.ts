import type Anthropic from "@anthropic-ai/sdk";
import * as THREE from "three";
import { z } from "zod";
import { buildNode, validatePrimitive } from "../geom/kernel";
import type { Doc } from "../model/doc";
import { rotateNodes } from "../model/transform";
import { DEFAULT_PARAMS, PRIMITIVE_KINDS, type PrimitiveNode, type PrimitiveParams, type SceneNode } from "../model/types";
import type { ViewName } from "../view/viewport";

// --- schemas -----------------------------------------------------------------

const num = z.number().finite();
const vec3 = z.tuple([num, num, num]);
const vec2 = z.tuple([num, num]);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "colour must be #rrggbb");

const dims = {
  width: num.positive().optional(),
  depth: num.positive().optional(),
  height: num.positive().optional(),
  radius: num.positive().optional(),
  top_radius: num.min(0).optional(),
  inner_radius: num.positive().optional(),
  minor_radius: num.positive().optional(),
  fillet: num.min(0).optional(),
  sides: z.number().int().min(3).max(256).optional(),
  points: z.array(vec2).min(3).optional(),
  profile: z.array(vec2).min(3).optional(),
};

const AddShape = z.object({
  kind: z.enum(PRIMITIVE_KINDS),
  name: z.string().max(80).optional(),
  position: vec3,
  rotation: vec3.optional(),
  color: color.optional(),
  hole: z.boolean().optional(),
  group: z.string().optional(),
  ...dims,
});
const UpdateShape = z.object({
  id: z.string(),
  name: z.string().max(80).optional(),
  kind: z.enum(PRIMITIVE_KINDS).optional(),
  position: vec3.optional(),
  rotation: vec3.optional(),
  color: color.optional(),
  hole: z.boolean().optional(),
  ...dims,
});
const MoveShapes = z.object({
  ids: z.array(z.string()).min(1),
  by: vec3.optional(),
  center_to: vec3.optional(),
  drop_to_workplane: z.boolean().optional(),
});
const RotateShapes = z.object({
  ids: z.array(z.string()).min(1),
  angles: vec3,
  pivot: vec3.optional(),
});
const Ids = z.object({ ids: z.array(z.string()).min(1) });
const GroupShapes = z.object({ ids: z.array(z.string()).min(2), name: z.string().max(80).optional() });
const Id = z.object({ id: z.string() });
const Duplicate = z.object({ id: z.string(), offset: vec3.optional() });
const Snapshot = z.object({ view: z.enum(["iso", "top", "front", "right", "back", "left", "bottom"]).optional() });

// --- definitions sent to Claude ---------------------------------------------------

const vec3Schema = (description: string) => ({
  type: "array",
  items: { type: "number" },
  minItems: 3,
  maxItems: 3,
  description,
});
const pointsSchema = (description: string) => ({
  type: "array",
  items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
  minItems: 3,
  description,
});
const dimSchema = {
  width: { type: "number", description: "X size (box, wedge)" },
  depth: { type: "number", description: "Y size (box, wedge)" },
  height: { type: "number", description: "Z size (box, cylinder, cone, wedge, tube, polygon)" },
  radius: { type: "number", description: "cylinder/sphere radius, tube outer radius, cone bottom radius, torus ring radius" },
  top_radius: { type: "number", description: "cone top radius (0 = pointed)" },
  inner_radius: { type: "number", description: "tube inner radius" },
  minor_radius: { type: "number", description: "torus tube thickness radius" },
  fillet: { type: "number", description: "box only: radius of rounded edges" },
  sides: { type: "integer", description: "segments around round shapes (default 64; 6 gives a hexagonal prism)" },
  points: pointsSchema("polygon only: [x, y] outline, extruded along Z by `height`"),
  profile: pointsSchema("revolve only: [radius, z] outline revolved 360° around the Z axis; radius >= 0"),
};

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "add_shape",
    description:
      "Add one primitive. `position` is the centre of the shape's bounding box. Only the dimensions for its kind are used; the rest default. Set hole=true to make a hole (it only cuts once grouped with solids). Returns the new id and its world bounds.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...PRIMITIVE_KINDS] },
        name: { type: "string", description: "Short descriptive name, e.g. 'Mug body'" },
        position: vec3Schema("[x, y, z] centre of the bounding box, mm"),
        rotation: vec3Schema("[x, y, z] degrees about the centre, applied X then Y then Z"),
        color: { type: "string", description: "#rrggbb" },
        hole: { type: "boolean" },
        group: { type: "string", description: "Optional id of an existing group to add the shape into" },
        ...dimSchema,
      },
      required: ["kind", "position"],
    },
  },
  {
    name: "update_shape",
    description:
      "Change any properties of an existing primitive (dimensions, position, rotation, colour, hole, name, even kind). For groups only name, color and hole can be changed; use move_shapes/rotate_shapes to transform a group.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        kind: { type: "string", enum: [...PRIMITIVE_KINDS] },
        position: vec3Schema("new bounding-box centre"),
        rotation: vec3Schema("new absolute rotation in degrees"),
        color: { type: "string" },
        hole: { type: "boolean" },
        ...dimSchema,
      },
      required: ["id"],
    },
  },
  {
    name: "move_shapes",
    description:
      "Move shapes or groups together. Give `by` (relative offset), or `center_to` (put the combined bounding-box centre there), and/or drop_to_workplane=true (rest the lowest point on z=0).",
    input_schema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" } },
        by: vec3Schema("[dx, dy, dz] mm"),
        center_to: vec3Schema("[x, y, z] target centre"),
        drop_to_workplane: { type: "boolean" },
      },
      required: ["ids"],
    },
  },
  {
    name: "rotate_shapes",
    description: "Rotate shapes or groups by `angles` degrees (X, then Y, then Z, world axes) about `pivot` (default: their combined centre).",
    input_schema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" } },
        angles: vec3Schema("[x, y, z] degrees"),
        pivot: vec3Schema("[x, y, z] world point to rotate about"),
      },
      required: ["ids", "angles"],
    },
  },
  {
    name: "group_shapes",
    description:
      "Combine shapes into one object: solids are merged and holes are cut out of them. This is how you subtract. Returns the group id. Groups can be nested.",
    input_schema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } }, name: { type: "string" } },
      required: ["ids"],
    },
  },
  {
    name: "ungroup",
    description: "Split a group back into its parts.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "duplicate_shape",
    description: "Copy a shape or group, offset by `offset` mm (default [10, 10, 0]). Returns the copy's id.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" }, offset: vec3Schema("[dx, dy, dz]") },
      required: ["id"],
    },
  },
  {
    name: "delete_shapes",
    description: "Delete shapes or groups (and everything inside them).",
    input_schema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] },
  },
  {
    name: "get_scene",
    description: "Return the full current scene tree with ids, parameters and world bounds.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "view_snapshot",
    description: "Render the scene from a viewpoint and look at it. Use it to check your work, especially after cutting holes.",
    input_schema: {
      type: "object",
      properties: { view: { type: "string", enum: ["iso", "top", "front", "right", "back", "left", "bottom"] } },
    },
  },
].map((t) => ({ ...t, eager_input_streaming: true }) as Anthropic.Beta.BetaTool);

// --- scene description ---------------------------------------------------------

const r3 = (v: number) => Math.round(v * 100) / 100;

function describeNode(doc: Doc, n: SceneNode): Record<string, unknown> {
  const b = buildNode(doc, n.id);
  const bounds = b.bounds ? { min: b.bounds.min.map(r3), max: b.bounds.max.map(r3) } : null;
  if (n.type === "group") {
    return {
      id: n.id,
      type: "group",
      name: n.name,
      hole: n.hole || undefined,
      color: n.color ?? undefined,
      bounds,
      error: b.error ?? undefined,
      children: doc.children(n.id).map((c) => describeNode(doc, c)),
    };
  }
  return {
    id: n.id,
    kind: n.kind,
    name: n.name,
    hole: n.hole || undefined,
    color: n.color,
    position: n.position,
    rotation: n.rotation.some((v) => v !== 0) ? n.rotation : undefined,
    params: relevantParams(n),
    bounds,
    error: b.error ?? undefined,
  };
}

const RELEVANT: Record<PrimitiveNode["kind"], (keyof PrimitiveParams)[]> = {
  box: ["width", "depth", "height", "fillet"],
  cylinder: ["radius", "height", "sides"],
  cone: ["radius", "top_radius", "height", "sides"],
  sphere: ["radius", "sides"],
  torus: ["radius", "minor_radius", "sides"],
  wedge: ["width", "depth", "height"],
  tube: ["radius", "inner_radius", "height", "sides"],
  polygon: ["points", "height"],
  revolve: ["profile", "sides"],
};

function relevantParams(n: PrimitiveNode): PrimitiveParams {
  const out: Record<string, unknown> = {};
  for (const k of RELEVANT[n.kind]) {
    const v = n.params[k];
    if (v === undefined) continue;
    if (k === "sides" && v === 64) continue;
    if (k === "fillet" && !v) continue;
    out[k] = v;
  }
  return out as PrimitiveParams;
}

export function describeScene(doc: Doc): string {
  const roots = doc.roots();
  if (roots.length === 0) return "The scene is empty.";
  return JSON.stringify(roots.map((r) => describeNode(doc, r)));
}

// --- execution -----------------------------------------------------------------

export interface ToolHost {
  doc: Doc;
  snapshot(view: ViewName): string;
  select(ids: string[]): void;
}

export type ToolOutput = { content: Anthropic.Beta.BetaToolResultBlockParam["content"]; isError: boolean; summary: string; touched: string[] };

function pickDims(input: Record<string, unknown>): PrimitiveParams | undefined {
  const p: Record<string, unknown> = {};
  for (const k of Object.keys(dims)) if (input[k] !== undefined) p[k] = input[k];
  return Object.keys(p).length ? (p as PrimitiveParams) : undefined;
}

function boundsOf(doc: Doc, id: string) {
  const b = buildNode(doc, id);
  if (b.error) throw new Error(b.error);
  return b.bounds ? { min: b.bounds.min.map(r3), max: b.bounds.max.map(r3) } : null;
}

function ok(summary: string, data: unknown, touched: string[]): ToolOutput {
  return { content: JSON.stringify(data), isError: false, summary, touched };
}

/** Runs one tool call against the document. Every mutating call is one undo step. */
export function runTool(host: ToolHost, name: string, raw: unknown): ToolOutput {
  const { doc } = host;
  const parse = <T>(schema: z.ZodType<T>): T => {
    const r = schema.safeParse(raw ?? {});
    if (!r.success) {
      throw new Error(`invalid input: ${r.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
    }
    return r.data;
  };
  const need = (id: string) => {
    const n = doc.get(id);
    if (!n) throw new Error(`no shape with id "${id}"`);
    return n;
  };

  switch (name) {
    case "add_shape": {
      const i = parse(AddShape);
      if (i.group && need(i.group).type !== "group") throw new Error(`${i.group} is not a group`);
      const params = pickDims(i);
      // Validate before touching the document so a bad call leaves no trace.
      validatePrimitive({
        id: "probe",
        type: "primitive",
        name: "probe",
        parent: null,
        kind: i.kind,
        params: { ...DEFAULT_PARAMS[i.kind], ...params },
        position: i.position,
        rotation: i.rotation ?? [0, 0, 0],
        color: "#000000",
        hole: false,
      });
      const n = doc.addPrimitive(
        { kind: i.kind, name: i.name, params, position: i.position, rotation: i.rotation, color: i.color, hole: i.hole, parent: i.group ?? null },
        "ai",
      );
      host.select([n.id]);
      return ok(`Added ${n.hole ? "hole " : ""}${n.kind} “${n.name}”`, { id: n.id, name: n.name, bounds: boundsOf(doc, n.id) }, [n.id]);
    }
    case "update_shape": {
      const i = parse(UpdateShape);
      need(i.id);
      doc.update(i.id, { name: i.name, kind: i.kind, position: i.position, rotation: i.rotation, color: i.color, hole: i.hole, params: pickDims(i) }, "ai");
      const after = doc.get(i.id)!;
      if (after.type === "primitive") {
        try {
          validatePrimitive(after);
        } catch (err) {
          doc.discardLast();
          throw err;
        }
      }
      host.select([i.id]);
      return ok(`Updated “${after.name}”`, { id: i.id, bounds: boundsOf(doc, i.id) }, [i.id]);
    }
    case "move_shapes": {
      const i = parse(MoveShapes);
      i.ids.forEach(need);
      if (!i.by && !i.center_to && !i.drop_to_workplane) throw new Error("give by, center_to or drop_to_workplane");
      doc.transact("Move", "ai", () => {
        if (i.by) for (const id of i.ids) doc.translate(id, i.by, "ai");
        if (i.center_to) {
          const b = combined(doc, i.ids);
          const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
          const d: [number, number, number] = [i.center_to[0] - c[0], i.center_to[1] - c[1], i.center_to[2] - c[2]];
          for (const id of i.ids) doc.translate(id, d, "ai");
        }
        if (i.drop_to_workplane) {
          const b = combined(doc, i.ids);
          for (const id of i.ids) doc.translate(id, [0, 0, -b.min[2]], "ai");
        }
      });
      host.select(i.ids);
      return ok(`Moved ${names(doc, i.ids)}`, { bounds: Object.fromEntries(i.ids.map((id) => [id, boundsOf(doc, id)])) }, i.ids);
    }
    case "rotate_shapes": {
      const i = parse(RotateShapes);
      i.ids.forEach(need);
      const b = combined(doc, i.ids);
      const pivot = i.pivot ?? ([(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2] as [number, number, number]);
      const d = THREE.MathUtils.degToRad;
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(d(i.angles[0]), d(i.angles[1]), d(i.angles[2]), "ZYX"));
      rotateNodes(doc, i.ids, pivot, q, "ai");
      host.select(i.ids);
      return ok(`Rotated ${names(doc, i.ids)}`, { bounds: Object.fromEntries(i.ids.map((id) => [id, boundsOf(doc, id)])) }, i.ids);
    }
    case "group_shapes": {
      const i = parse(GroupShapes);
      i.ids.forEach(need);
      const g = doc.group(i.ids, i.name, "ai");
      const built = buildNode(doc, g.id);
      if (built.error) {
        doc.discardLast();
        throw new Error(`grouping failed: ${built.error}`);
      }
      host.select([g.id]);
      return ok(`Grouped into “${g.name}”`, { id: g.id, name: g.name, bounds: boundsOf(doc, g.id), volume_mm3: Math.round(built.volume) }, [g.id]);
    }
    case "ungroup": {
      const i = parse(Id);
      const kids = doc.ungroup(i.id, "ai");
      host.select(kids);
      return ok("Ungrouped", { ids: kids }, kids);
    }
    case "duplicate_shape": {
      const i = parse(Duplicate);
      need(i.id);
      const c = doc.duplicate(i.id, i.offset ?? [10, 10, 0], "ai");
      host.select([c.id]);
      return ok(`Duplicated as “${c.name}”`, { id: c.id, name: c.name, bounds: boundsOf(doc, c.id) }, [c.id]);
    }
    case "delete_shapes": {
      const i = parse(Ids);
      const label = names(doc, i.ids);
      i.ids.forEach(need);
      doc.remove(i.ids, "ai");
      host.select([]);
      return ok(`Deleted ${label}`, { deleted: i.ids }, []);
    }
    case "get_scene":
      return { content: describeScene(doc), isError: false, summary: "Looked at the scene", touched: [] };
    case "view_snapshot": {
      const i = parse(Snapshot);
      const view = i.view ?? "iso";
      const png = host.snapshot(view);
      return {
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
          { type: "text", text: `${view} view. Holes that are not grouped show as translucent grey.` },
        ],
        isError: false,
        summary: `Checked the ${view} view`,
        touched: [],
      };
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

function combined(doc: Doc, ids: string[]) {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const id of ids) {
    const b = buildNode(doc, id).bounds;
    if (!b) continue;
    min = min.map((v, k) => Math.min(v, b.min[k]));
    max = max.map((v, k) => Math.max(v, b.max[k]));
  }
  if (!Number.isFinite(min[0])) throw new Error("those shapes have no geometry");
  return { min, max };
}

function names(doc: Doc, ids: string[]): string {
  const ns = ids.map((id) => doc.get(id)?.name ?? id);
  return ns.length <= 3 ? ns.map((n) => `“${n}”`).join(", ") : `${ns.length} shapes`;
}
