// Scene model. Units are millimetres, Z is up, the workplane is z = 0.
// A shape's `position` is the centre of its (unrotated) bounding box and its
// `rotation` is in degrees, applied about that centre: X first, then Y, then Z.

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export const PRIMITIVE_KINDS = [
  "box",
  "cylinder",
  "cone",
  "sphere",
  "torus",
  "wedge",
  "tube",
  "polygon",
  "revolve",
] as const;
export type PrimitiveKind = (typeof PRIMITIVE_KINDS)[number];

/** Every dimension a primitive can use; each kind reads only its own subset. */
export interface PrimitiveParams {
  width?: number; // X extent (box, wedge)
  depth?: number; // Y extent (box, wedge)
  height?: number; // Z extent (box, cylinder, cone, wedge, tube, polygon)
  radius?: number; // cylinder, sphere, tube (outer), cone (bottom), torus (ring)
  top_radius?: number; // cone
  inner_radius?: number; // tube
  minor_radius?: number; // torus (thickness of the ring)
  fillet?: number; // box: rounded edge radius
  sides?: number; // segment count for round shapes
  points?: Vec2[]; // polygon: outline in the XY plane
  profile?: Vec2[]; // revolve: [radius, z] outline revolved around Z
}

interface NodeBase {
  id: string;
  name: string;
  parent: string | null;
}

export interface PrimitiveNode extends NodeBase {
  type: "primitive";
  kind: PrimitiveKind;
  params: PrimitiveParams;
  position: Vec3;
  rotation: Vec3;
  color: string;
  hole: boolean;
}

/** A group merges its children: solids are unioned, holes are subtracted. */
export interface GroupNode extends NodeBase {
  type: "group";
  color: string | null; // null: use the first solid child's colour
  hole: boolean;
}

export type SceneNode = PrimitiveNode | GroupNode;

export interface SceneDoc {
  version: 1;
  /** Insertion-ordered; children are found by `parent`. */
  nodes: SceneNode[];
}

export const DEFAULT_PARAMS: Record<PrimitiveKind, PrimitiveParams> = {
  box: { width: 20, depth: 20, height: 20, fillet: 0 },
  cylinder: { radius: 10, height: 20, sides: 64 },
  cone: { radius: 10, top_radius: 0, height: 20, sides: 64 },
  sphere: { radius: 10, sides: 64 },
  torus: { radius: 15, minor_radius: 4, sides: 64 },
  wedge: { width: 20, depth: 20, height: 20 },
  tube: { radius: 10, inner_radius: 7, height: 20, sides: 64 },
  polygon: {
    points: [
      [0, 10],
      [9.5, 3.1],
      [5.9, -8.1],
      [-5.9, -8.1],
      [-9.5, 3.1],
    ],
    height: 10,
  },
  revolve: {
    profile: [
      [0, 0],
      [12, 0],
      [12, 2],
      [8, 4],
      [9, 25],
      [7.5, 25],
      [6.5, 5],
      [0, 5],
    ],
    sides: 64,
  },
};

export const KIND_LABELS: Record<PrimitiveKind, string> = {
  box: "Box",
  cylinder: "Cylinder",
  cone: "Cone",
  sphere: "Sphere",
  torus: "Torus",
  wedge: "Wedge",
  tube: "Tube",
  polygon: "Polygon",
  revolve: "Revolve",
};

export const PALETTE = [
  "#e8553e",
  "#f2a33a",
  "#f5d547",
  "#5cb85c",
  "#3fa7d6",
  "#5865f2",
  "#a05cd6",
  "#e87fb4",
  "#8d6e63",
  "#9e9e9e",
  "#f5f5f5",
  "#333333",
];
