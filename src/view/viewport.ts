import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { buildNode, unionBounds, type Bounds, type BuiltNode } from "../geom/kernel";
import type { Doc } from "../model/doc";
import type { SceneNode } from "../model/types";

export type ViewName = "iso" | "top" | "front" | "right" | "back" | "left" | "bottom";
export type GizmoMode = "translate" | "rotate" | "scale";

/** What the viewport tells the app when the user drags the gizmo. */
export interface GizmoEdit {
  mode: GizmoMode;
  /** World-space centre the gizmo started at. */
  pivot: THREE.Vector3;
  delta: THREE.Vector3; // translate
  rotation: THREE.Quaternion; // rotate (relative)
  scale: THREE.Vector3; // scale (relative)
}

interface Item {
  id: string;
  built: BuiltNode;
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
  born: number; // ms timestamp of the pop-in animation start, 0 when settled
}

const VIEW_DIRS: Record<ViewName, [number, number, number]> = {
  iso: [1, -1.25, 0.95],
  top: [0, -0.0001, 1],
  bottom: [0, 0.0001, -1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  right: [1, 0, 0],
  left: [-1, 0, 0],
};

const POP_MS = 450;

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly orbit: OrbitControls;
  readonly gizmo: TransformControls;
  private proxy = new THREE.Object3D();
  private items = new Map<string, Item>();
  private childGhost: THREE.LineSegments | null = null;
  private grid = new THREE.Group();
  private selection: string[] = [];
  private raycaster = new THREE.Raycaster();
  private downAt: { x: number; y: number } | null = null;
  private gizmoStart = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) };
  private camAnim: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; start: number } | null = null;

  onPick: (id: string | null, additive: boolean) => void = () => {};
  onGizmoEdit: (e: GizmoEdit) => void = () => {};

  constructor(private host: HTMLElement, private doc: Doc) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 20000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(160, -200, 150);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.target.set(0, 0, 0);

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    // Fingers need bigger handles than a mouse pointer.
    this.gizmo.setSize(window.matchMedia("(pointer: coarse)").matches ? 1.35 : 0.9);
    this.scene.add(this.gizmo.getHelper());
    this.scene.add(this.proxy);
    this.gizmo.addEventListener("dragging-changed", (e) => {
      this.orbit.enabled = !e.value;
      if (e.value) {
        this.gizmoStart.pos.copy(this.proxy.position);
        this.gizmoStart.quat.copy(this.proxy.quaternion);
        this.gizmoStart.scale.copy(this.proxy.scale);
      } else this.commitGizmo();
    });
    this.gizmo.addEventListener("objectChange", () => this.previewGizmo());
    // Hovering or dragging a gizmo handle changes how it's drawn.
    this.gizmo.addEventListener("change", () => this.invalidate());

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(120, -160, 300);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-200, 150, 80);
    this.scene.add(fill);

    this.buildGrid();
    this.scene.add(this.grid);
    this.applyTheme();
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.applyTheme());

    const el = this.renderer.domElement;
    // A tap selects; a drag, or any gesture that used two fingers, doesn't.
    const down = new Set<number>();
    let multiTouch = false;
    el.addEventListener("pointerdown", (e) => {
      down.add(e.pointerId);
      if (down.size > 1) multiTouch = true;
      this.downAt = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener("pointercancel", (e) => down.delete(e.pointerId));
    el.addEventListener("pointerup", (e) => {
      down.delete(e.pointerId);
      if (multiTouch) {
        if (down.size === 0) multiTouch = false;
        this.downAt = null;
        return;
      }
      if (!this.downAt) return;
      const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y);
      this.downAt = null;
      if (moved > 4 || this.gizmo.dragging || e.button !== 0) return;
      // TransformControls swallows clicks on its own handles via `axis`.
      if (this.gizmo.axis) return;
      this.onPick(this.pick(e), e.shiftKey || e.ctrlKey || e.metaKey);
    });

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  applyTheme(): void {
    this.invalidate();
    this.scene.background = new THREE.Color(cssVar("--viewport-bg", "#eef1f5"));
    const minor = new THREE.Color(cssVar("--grid-minor", "#d5dbe3"));
    const major = new THREE.Color(cssVar("--grid-major", "#aab4c2"));
    const plane = new THREE.Color(cssVar("--workplane", "#ffffff"));
    this.grid.children.forEach((c) => {
      const m = (c as THREE.Mesh).material as THREE.MeshBasicMaterial | THREE.LineBasicMaterial;
      if (c.userData.role === "minor") m.color = minor;
      if (c.userData.role === "major") m.color = major;
      if (c.userData.role === "plane") m.color = plane;
    });
  }

  private buildGrid(size = 200): void {
    const half = size / 2;
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }),
    );
    plane.userData.role = "plane";
    plane.renderOrder = -2;
    plane.position.z = -0.02;
    this.grid.add(plane);
    const minor: number[] = [];
    const major: number[] = [];
    for (let v = -half; v <= half; v += 2) {
      const arr = v % 10 === 0 ? major : minor;
      arr.push(-half, v, 0, half, v, 0, v, -half, 0, v, half, 0);
    }
    for (const [arr, role] of [
      [minor, "minor"],
      [major, "major"],
    ] as const) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ transparent: true, opacity: role === "major" ? 0.9 : 0.6 }));
      l.userData.role = role;
      l.renderOrder = -1;
      this.grid.add(l);
    }
  }

  private bottomInset = 0;

  /**
   * Pixels at the bottom of the viewport covered by a panel. The projection
   * shifts up by half of it, so the model stays centred in the part you can see.
   */
  setBottomInset(px: number): void {
    this.bottomInset = Math.max(0, px);
    this.resize();
  }

  private resize(): void {
    this.invalidate();
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    if (this.bottomInset > 0) this.camera.setViewOffset(w, h, 0, this.bottomInset / 2, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  private frame(): void {
    const now = performance.now();
    const animating = !!this.camAnim || [...this.items.values()].some((it) => it.born);
    if (this.camAnim) {
      const t = Math.min(1, (now - this.camAnim.start) / 500);
      const e = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(this.camAnim.from, this.camAnim.to, e);
      this.orbit.target.lerpVectors(this.camAnim.tFrom, this.camAnim.tTo, e);
      if (t >= 1) this.camAnim = null;
    }
    for (const it of this.items.values()) {
      if (!it.born) continue;
      const t = Math.min(1, (now - it.born) / POP_MS);
      // Ease out with a small overshoot so new shapes visibly "land".
      const s = t >= 1 ? 1 : 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);
      it.mesh.scale.setScalar(Math.max(0.001, s));
      const mat = it.mesh.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 0.55 * (1 - t);
      if (t >= 1) it.born = 0;
    }
    // Draw only when something changed: an idle viewport costs no CPU.
    if (this.orbit.update() || animating) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
  }

  private dirty = true;
  /** Asks for a redraw on the next frame. */
  invalidate(): void {
    this.dirty = true;
  }

  // --- scene sync ----------------------------------------------------------

  /** Rebuilds meshes for changed top-level nodes. `created` ids pop in. */
  sync(created: string[] = []): void {
    this.invalidate();
    const roots = this.doc.roots();
    const live = new Set(roots.map((r) => r.id));
    for (const [id, it] of this.items) {
      if (!live.has(id)) {
        this.disposeItem(it);
        this.items.delete(id);
      }
    }
    const createdTop = new Set(created.map((id) => this.doc.topLevelOf(id)?.id).filter(Boolean));
    for (const r of roots) {
      const built = buildNode(this.doc, r.id);
      const prev = this.items.get(r.id);
      const look = this.lookKey(r);
      if (prev && prev.built === built && prev.mesh.userData.look === look) continue;
      if (prev) {
        this.disposeItem(prev);
        this.items.delete(r.id);
      }
      if (!built.mesh) continue;
      const item = this.makeItem(r, built);
      item.mesh.userData.look = look;
      if (createdTop.has(r.id)) item.born = performance.now();
      this.items.set(r.id, item);
    }
    this.setSelection(this.selection.filter((id) => this.doc.get(id)));
  }

  private lookKey(n: SceneNode): string {
    return `${this.colorOf(n)}|${n.hole}`;
  }

  private colorOf(n: SceneNode): string {
    if (n.type === "primitive") return n.color;
    if (n.color) return n.color;
    const first = this.doc.primitivesUnder(n.id).find((p) => !p.hole);
    return first?.color ?? "#9e9e9e";
  }

  private makeItem(node: SceneNode, built: BuiltNode): Item {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(built.mesh!.positions, 3));
    g.setIndex(new THREE.BufferAttribute(built.mesh!.indices, 1));
    // Flat shading reads better for CAD than smoothed normals across hard edges.
    const flat = g.toNonIndexed();
    g.dispose();
    flat.computeVertexNormals();
    const b = built.bounds!;
    const c = new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
    flat.translate(-c.x, -c.y, -c.z);
    const color = new THREE.Color(this.colorOf(node));
    const mat = node.hole
      ? new THREE.MeshStandardMaterial({ color: 0x8a96a8, transparent: true, opacity: 0.35, depthWrite: false, roughness: 0.6 })
      : new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, emissive: color, emissiveIntensity: 0 });
    mat.flatShading = true;
    const mesh = new THREE.Mesh(flat, mat);
    mesh.position.copy(c);
    mesh.userData.id = node.id;
    mesh.userData.hole = node.hole;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(flat, 30),
      new THREE.LineBasicMaterial({ color: node.hole ? 0x5a6678 : 0x000000, transparent: true, opacity: node.hole ? 0.6 : 0.18 }),
    );
    mesh.add(edges);
    this.scene.add(mesh);
    return { id: node.id, built, mesh, edges, born: 0 };
  }

  private disposeItem(it: Item): void {
    this.scene.remove(it.mesh);
    it.mesh.geometry.dispose();
    (it.mesh.material as THREE.Material).dispose();
    it.edges.geometry.dispose();
    (it.edges.material as THREE.Material).dispose();
  }

  // --- selection & gizmo -----------------------------------------------------

  setSelection(ids: string[]): void {
    this.invalidate();
    this.selection = ids;
    const sel = new Set(ids);
    for (const it of this.items.values()) {
      const on = sel.has(it.id);
      const m = it.edges.material as THREE.LineBasicMaterial;
      m.color.set(on ? cssVar("--accent", "#3b82f6") : it.mesh.userData.hole ? 0x5a6678 : 0x000000);
      m.opacity = on ? 1 : (it.mesh.material as THREE.Material).transparent ? 0.6 : 0.18;
    }
    if (this.childGhost) {
      this.scene.remove(this.childGhost);
      this.childGhost.geometry.dispose();
      this.childGhost = null;
    }
    // A shape inside a group has no mesh of its own; outline it separately.
    const inner = ids.filter((id) => this.doc.get(id)?.parent);
    if (inner.length) {
      const pos: number[] = [];
      for (const id of inner) {
        const built = buildNode(this.doc, id);
        if (!built.mesh) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(built.mesh.positions, 3));
        g.setIndex(new THREE.BufferAttribute(built.mesh.indices, 1));
        const e = new THREE.EdgesGeometry(g, 30);
        pos.push(...(e.getAttribute("position").array as Float32Array));
        g.dispose();
        e.dispose();
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      this.childGhost = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: cssVar("--accent", "#3b82f6"), depthTest: false, transparent: true }));
      this.childGhost.renderOrder = 10;
      this.scene.add(this.childGhost);
    }
    this.placeGizmo();
  }

  selectionBounds(ids = this.selection): Bounds | null {
    return unionBounds(ids.map((id) => buildNode(this.doc, id).bounds));
  }

  private placeGizmo(): void {
    const b = this.selectionBounds();
    if (!b || this.selection.length === 0) {
      this.gizmo.detach();
      return;
    }
    this.proxy.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
    this.proxy.quaternion.identity();
    this.proxy.scale.set(1, 1, 1);
    if (this.selection.length === 1) {
      const n = this.doc.get(this.selection[0]);
      if (n?.type === "primitive") {
        this.proxy.position.set(...n.position);
        this.proxy.rotation.copy(eulerOf(n.rotation));
      }
    }
    this.gizmo.attach(this.proxy);
  }

  setGizmoMode(mode: GizmoMode): void {
    this.invalidate();
    this.gizmo.setMode(mode);
    // Scaling only makes sense in the shape's own axes.
    this.gizmo.setSpace(mode === "translate" ? "world" : "local");
  }

  setSnap(mm: number | null, deg: number | null): void {
    this.gizmo.setTranslationSnap(mm);
    this.gizmo.setRotationSnap(deg === null ? null : THREE.MathUtils.degToRad(deg));
    this.gizmo.setScaleSnap(mm === null ? null : 0.05);
  }

  /** Live preview while dragging: move the meshes, commit on release. */
  private previewGizmo(): void {
    const e = this.currentEdit();
    for (const id of this.selection) {
      const top = this.doc.topLevelOf(id);
      const it = top && this.items.get(top.id);
      if (!it || top.id !== id) continue;
      if (e.mode === "translate") {
        const b = it.built.bounds!;
        it.mesh.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2).add(e.delta);
      }
    }
  }

  private currentEdit(): GizmoEdit {
    const mode = this.gizmo.mode as GizmoMode;
    const delta = this.proxy.position.clone().sub(this.gizmoStart.pos);
    // q1 · q0⁻¹: the world-space rotation applied during the drag.
    const rotation = this.proxy.quaternion.clone().multiply(this.gizmoStart.quat.clone().invert());
    const scale = this.proxy.scale.clone().divide(this.gizmoStart.scale);
    return { mode, pivot: this.gizmoStart.pos.clone(), delta, rotation, scale };
  }

  private commitGizmo(): void {
    const e = this.currentEdit();
    const moved =
      (e.mode === "translate" && e.delta.lengthSq() > 1e-8) ||
      (e.mode === "rotate" && Math.abs(e.rotation.w) < 0.999999) ||
      (e.mode === "scale" && e.scale.distanceToSquared(new THREE.Vector3(1, 1, 1)) > 1e-8);
    if (moved) this.onGizmoEdit(e);
    else this.placeGizmo();
  }

  private pick(e: PointerEvent): string | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = [...this.items.values()].map((i) => i.mesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    // Prefer solids over the translucent holes they sit inside.
    const solid = hits.find((h) => !((h.object as THREE.Mesh).material as THREE.Material).transparent);
    const hit = solid ?? hits[0];
    return hit ? (hit.object.userData.id as string) : null;
  }

  /** Where a screen point hits the workplane (z = 0), or null. */
  workplanePoint(clientX: number, clientY: number): [number, number] | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
    return hit ? [hit.x, hit.y] : null;
  }

  // --- camera ----------------------------------------------------------------

  private sceneBounds(): Bounds {
    const b = unionBounds([...this.items.values()].map((i) => i.built.bounds));
    return b ?? { min: [-40, -40, 0], max: [40, 40, 30] };
  }

  private framing(view: ViewName, b: Bounds, aspect = this.camera.aspect): { pos: THREE.Vector3; target: THREE.Vector3 } {
    const target = new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
    const radius = Math.max(15, new THREE.Vector3(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]).length() / 2);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * aspect));
    const dist = (radius / Math.sin(fit / 2)) * 1.08;
    const dir = new THREE.Vector3(...VIEW_DIRS[view]).normalize();
    return { pos: target.clone().addScaledVector(dir, dist), target };
  }

  setView(view: ViewName, ids?: string[]): void {
    const b = (ids?.length ? this.selectionBounds(ids) : null) ?? this.sceneBounds();
    const f = this.framing(view, b);
    this.camAnim = { from: this.camera.position.clone(), to: f.pos, tFrom: this.orbit.target.clone(), tTo: f.target, start: performance.now() };
  }

  /** Renders the scene from a named view into a PNG (base64, no prefix). */
  snapshot(view: ViewName = "iso", size = 768): string {
    const cam = this.camera.clone();
    cam.clearViewOffset(); // the on-screen sheet offset doesn't apply here
    cam.aspect = 1;
    const f = this.framing(view, this.sceneBounds(), 1);
    cam.position.copy(f.pos);
    cam.up.set(0, 0, 1);
    if (view === "top" || view === "bottom") cam.up.set(0, 1, 0);
    cam.lookAt(f.target);
    cam.updateProjectionMatrix();
    const helper = this.gizmo.getHelper();
    const wasVisible = helper.visible;
    helper.visible = false;
    const rt = new THREE.WebGLRenderTarget(size, size, { samples: 4 });
    // Without this the pixels come back in linear space and look too dark.
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.scene, cam);
    const px = new Uint8Array(size * size * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, size, size, px);
    this.renderer.setRenderTarget(null);
    rt.dispose();
    helper.visible = wasVisible;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(size, size);
    // WebGL rows are bottom-up.
    for (let y = 0; y < size; y++) img.data.set(px.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4);
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1];
  }
}

export function eulerOf(rotationDeg: [number, number, number]): THREE.Euler {
  // Manifold rotates about X, then Y, then Z: the matrix is Rz·Ry·Rx, which
  // three.js calls order "ZYX".
  const d = THREE.MathUtils.degToRad;
  return new THREE.Euler(d(rotationDeg[0]), d(rotationDeg[1]), d(rotationDeg[2]), "ZYX");
}

export function degreesOf(q: THREE.Quaternion): [number, number, number] {
  const e = new THREE.Euler().setFromQuaternion(q, "ZYX");
  const r = (v: number) => {
    const deg = Math.round(THREE.MathUtils.radToDeg(v) * 1000) / 1000;
    return Object.is(deg, -0) ? 0 : deg;
  };
  return [r(e.x), r(e.y), r(e.z)];
}
