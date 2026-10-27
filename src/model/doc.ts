import {
  DEFAULT_PARAMS,
  KIND_LABELS,
  PALETTE,
  type GroupNode,
  type PrimitiveKind,
  type PrimitiveNode,
  type PrimitiveParams,
  type SceneDoc,
  type SceneNode,
  type Vec3,
} from "./types";

export interface ChangeEvent {
  /** Short human label, also used for the undo stack. */
  label: string;
  /** Nodes created by this change (the viewport animates them in). */
  created: string[];
  /** Who made the change. */
  source: "user" | "ai" | "history" | "load";
}

type Listener = (e: ChangeEvent) => void;

export interface PrimitiveInit {
  kind: PrimitiveKind;
  name?: string;
  params?: PrimitiveParams;
  position?: Vec3;
  rotation?: Vec3;
  color?: string;
  hole?: boolean;
  parent?: string | null;
}

export type NodePatch = Partial<
  Pick<PrimitiveNode, "name" | "position" | "rotation" | "color" | "hole" | "params" | "kind">
>;

const HISTORY_LIMIT = 200;

let idCounter = 0;
function newId(nodes: SceneNode[]): string {
  const taken = new Set(nodes.map((n) => n.id));
  let id: string;
  do id = `s${++idCounter}`;
  while (taken.has(id));
  return id;
}

export class Doc {
  private nodes: SceneNode[] = [];
  private undoStack: { label: string; nodes: SceneNode[] }[] = [];
  private redoStack: { label: string; nodes: SceneNode[] }[] = [];
  private listeners = new Set<Listener>();
  /** Bumped on every change; lets the AI notice manual edits between turns. */
  revision = 0;

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  all(): readonly SceneNode[] {
    return this.nodes;
  }

  get(id: string): SceneNode | undefined {
    return this.nodes.find((n) => n.id === id);
  }

  children(id: string | null): SceneNode[] {
    return this.nodes.filter((n) => n.parent === id);
  }

  roots(): SceneNode[] {
    return this.children(null);
  }

  /** The node plus every descendant, parents before children. */
  subtree(id: string): SceneNode[] {
    const node = this.get(id);
    if (!node) return [];
    const out = [node];
    for (const c of this.children(id)) out.push(...this.subtree(c.id));
    return out;
  }

  /** Every primitive inside the node (or the node itself). */
  primitivesUnder(id: string): PrimitiveNode[] {
    return this.subtree(id).filter((n): n is PrimitiveNode => n.type === "primitive");
  }

  topLevelOf(id: string): SceneNode | undefined {
    let n = this.get(id);
    while (n && n.parent) n = this.get(n.parent);
    return n;
  }

  // --- mutations -----------------------------------------------------------

  /**
   * Runs `fn` as one undoable step. Nested calls fold into the outer one.
   */
  private depth = 0;
  private pendingCreated: string[] = [];
  transact<T>(label: string, source: ChangeEvent["source"], fn: () => T): T {
    if (this.depth === 0) {
      this.undoStack.push({ label, nodes: structuredClone(this.nodes) });
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
      this.pendingCreated = [];
    }
    this.depth++;
    let result: T;
    try {
      result = fn();
    } catch (err) {
      this.depth--;
      if (this.depth === 0) this.nodes = this.undoStack.pop()!.nodes;
      throw err;
    }
    this.depth--;
    if (this.depth === 0) this.emit({ label, created: this.pendingCreated, source });
    return result;
  }

  addPrimitive(init: PrimitiveInit, source: ChangeEvent["source"] = "user"): PrimitiveNode {
    return this.transact(`Add ${KIND_LABELS[init.kind]}`, source, () => {
      const params = { ...DEFAULT_PARAMS[init.kind], ...(init.params ?? {}) };
      const node: PrimitiveNode = {
        id: newId(this.nodes),
        type: "primitive",
        kind: init.kind,
        name: init.name?.trim() || this.uniqueName(KIND_LABELS[init.kind]),
        parent: init.parent ?? null,
        params: structuredClone(params),
        position: init.position ?? [0, 0, defaultHeight(init.kind, params) / 2],
        rotation: init.rotation ?? [0, 0, 0],
        color: init.color ?? PALETTE[this.nodes.length % 6],
        hole: init.hole ?? false,
      };
      if (node.parent && this.get(node.parent)?.type !== "group") {
        throw new Error(`parent ${node.parent} is not a group`);
      }
      this.nodes.push(node);
      this.pendingCreated.push(node.id);
      return node;
    });
  }

  update(id: string, patch: NodePatch, source: ChangeEvent["source"] = "user", label?: string): void {
    const node = this.get(id);
    if (!node) throw new Error(`no shape with id ${id}`);
    this.transact(label ?? `Edit ${node.name}`, source, () => {
      if (patch.name !== undefined) node.name = patch.name;
      if (patch.color !== undefined) node.color = patch.color;
      if (patch.hole !== undefined) node.hole = patch.hole;
      if (node.type === "primitive") {
        if (patch.kind !== undefined && patch.kind !== node.kind) {
          node.kind = patch.kind;
          node.params = { ...DEFAULT_PARAMS[patch.kind], ...node.params };
        }
        if (patch.position) node.position = [...patch.position];
        if (patch.rotation) node.rotation = [...patch.rotation];
        if (patch.params) node.params = { ...node.params, ...structuredClone(patch.params) };
      } else if (patch.position || patch.rotation || patch.params) {
        throw new Error(`${node.name} is a group; move or rotate it with transform_group`);
      }
    });
  }

  /** Moves every primitive in the subtree by `delta`. */
  translate(id: string, delta: Vec3, source: ChangeEvent["source"] = "user"): void {
    const node = this.get(id);
    if (!node) throw new Error(`no shape with id ${id}`);
    this.transact(`Move ${node.name}`, source, () => {
      for (const p of this.primitivesUnder(id)) {
        p.position = [p.position[0] + delta[0], p.position[1] + delta[1], p.position[2] + delta[2]];
      }
    });
  }

  /** Replaces the transforms of several primitives at once (group rotate/scale). */
  setTransforms(
    label: string,
    items: { id: string; position: Vec3; rotation: Vec3; params?: PrimitiveParams }[],
    source: ChangeEvent["source"] = "user",
  ): void {
    this.transact(label, source, () => {
      for (const it of items) {
        const n = this.get(it.id);
        if (n?.type !== "primitive") continue;
        n.position = [...it.position];
        n.rotation = [...it.rotation];
        if (it.params) n.params = structuredClone(it.params);
      }
    });
  }

  remove(ids: string[], source: ChangeEvent["source"] = "user"): void {
    const doomed = new Set(ids.flatMap((id) => this.subtree(id).map((n) => n.id)));
    if (doomed.size === 0) return;
    const label = ids.length === 1 ? `Delete ${this.get(ids[0])?.name}` : `Delete ${ids.length} shapes`;
    this.transact(label, source, () => {
      this.nodes = this.nodes.filter((n) => !doomed.has(n.id));
      this.pruneEmptyGroups();
    });
  }

  group(ids: string[], name?: string, source: ChangeEvent["source"] = "user"): GroupNode {
    const unique = [...new Set(ids)].filter((id) => this.get(id));
    if (unique.length < 2) throw new Error("grouping needs at least two existing shapes");
    for (const id of unique) {
      for (const other of unique) {
        if (other !== id && this.subtree(other).some((n) => n.id === id)) {
          throw new Error(`${id} is already inside ${other}`);
        }
      }
    }
    return this.transact(name ? `Group ${name}` : "Group", source, () => {
      const parent = this.get(unique[0])!.parent;
      const g: GroupNode = {
        id: newId(this.nodes),
        type: "group",
        name: name?.trim() || this.uniqueName("Group"),
        parent,
        color: null,
        hole: false,
      };
      // Insert where the first member was so the tree keeps its order.
      const at = this.nodes.findIndex((n) => n.id === unique[0]);
      this.nodes.splice(at, 0, g);
      for (const id of unique) this.get(id)!.parent = g.id;
      this.pruneEmptyGroups();
      this.pendingCreated.push(g.id);
      return g;
    });
  }

  ungroup(id: string, source: ChangeEvent["source"] = "user"): string[] {
    const g = this.get(id);
    if (g?.type !== "group") throw new Error(`${id} is not a group`);
    return this.transact(`Ungroup ${g.name}`, source, () => {
      const kids = this.children(id);
      for (const k of kids) k.parent = g.parent;
      this.nodes = this.nodes.filter((n) => n.id !== id);
      return kids.map((k) => k.id);
    });
  }

  duplicate(id: string, offset: Vec3 = [10, 10, 0], source: ChangeEvent["source"] = "user"): SceneNode {
    const src = this.get(id);
    if (!src) throw new Error(`no shape with id ${id}`);
    return this.transact(`Duplicate ${src.name}`, source, () => {
      const map = new Map<string, string>();
      const copies: SceneNode[] = [];
      for (const n of this.subtree(id)) {
        const c = structuredClone(n);
        c.id = newId([...this.nodes, ...copies]);
        map.set(n.id, c.id);
        c.parent = n.id === id ? n.parent : map.get(n.parent!)!;
        if (n.id === id) c.name = this.uniqueName(n.name.replace(/ \d+$/, ""));
        if (c.type === "primitive") {
          c.position = [c.position[0] + offset[0], c.position[1] + offset[1], c.position[2] + offset[2]];
        }
        copies.push(c);
      }
      this.nodes.push(...copies);
      this.pendingCreated.push(copies[0].id);
      return copies[0];
    });
  }

  clear(source: ChangeEvent["source"] = "user"): void {
    this.transact("Clear scene", source, () => {
      this.nodes = [];
    });
  }

  // --- history ---------------------------------------------------------------

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  undo(): void {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push({ label: s.label, nodes: this.nodes });
    this.nodes = s.nodes;
    this.emit({ label: `Undo ${s.label}`, created: [], source: "history" });
  }
  /** Reverts the last step without making it redoable (for rejected edits). */
  discardLast(): void {
    const s = this.undoStack.pop();
    if (!s) return;
    this.nodes = s.nodes;
    this.emit({ label: `Revert ${s.label}`, created: [], source: "history" });
  }
  redo(): void {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push({ label: s.label, nodes: this.nodes });
    this.nodes = s.nodes;
    this.emit({ label: `Redo ${s.label}`, created: [], source: "history" });
  }

  // --- persistence -----------------------------------------------------------

  toJSON(): SceneDoc {
    return { version: 1, nodes: structuredClone(this.nodes) };
  }

  load(doc: SceneDoc, keepHistory = false): void {
    if (doc?.version !== 1 || !Array.isArray(doc.nodes)) throw new Error("not a Formwright scene");
    if (keepHistory) this.undoStack.push({ label: "Open", nodes: this.nodes });
    else this.undoStack = [];
    this.redoStack = [];
    this.nodes = structuredClone(doc.nodes);
    this.emit({ label: "Open", created: [], source: "load" });
  }

  // --- helpers ---------------------------------------------------------------

  private uniqueName(base: string): string {
    const names = new Set(this.nodes.map((n) => n.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
  }

  private pruneEmptyGroups(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of this.nodes) {
        if (n.type === "group" && this.children(n.id).length === 0) {
          this.nodes = this.nodes.filter((x) => x !== n);
          changed = true;
          break;
        }
      }
    }
  }

  private emit(e: ChangeEvent): void {
    this.revision++;
    for (const l of this.listeners) l(e);
  }
}

/** Z extent of a fresh primitive, used to rest new shapes on the workplane. */
export function defaultHeight(kind: PrimitiveKind, p: PrimitiveParams): number {
  switch (kind) {
    case "sphere":
      return 2 * (p.radius ?? 10);
    case "torus":
      return 2 * (p.minor_radius ?? 4);
    case "revolve": {
      const zs = (p.profile ?? []).map((v) => v[1]);
      return zs.length ? Math.max(...zs) - Math.min(...zs) : 0;
    }
    default:
      return p.height ?? 20;
  }
}
