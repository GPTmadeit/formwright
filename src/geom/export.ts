import type { MeshData } from "./kernel";

/** Binary STL. Units are millimetres, which is what slicers assume. */
export function toBinarySTL(mesh: MeshData): Uint8Array {
  const tris = mesh.indices.length / 3;
  const buf = new ArrayBuffer(84 + tris * 50);
  const view = new DataView(buf);
  const header = new TextEncoder().encode("Formwright STL");
  new Uint8Array(buf, 0, 80).set(header);
  view.setUint32(80, tris, true);
  const p = mesh.positions;
  let o = 84;
  for (let t = 0; t < tris; t++) {
    const a = mesh.indices[t * 3] * 3;
    const b = mesh.indices[t * 3 + 1] * 3;
    const c = mesh.indices[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const v of [nx, ny, nz, p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], p[c], p[c + 1], p[c + 2]]) {
      view.setFloat32(o, v, true);
      o += 4;
    }
    view.setUint16(o, 0, true);
    o += 2;
  }
  return new Uint8Array(buf);
}

/** Wavefront OBJ, for tools that prefer text formats. */
export function toOBJ(mesh: MeshData): string {
  const lines = ["# Formwright export (mm)"];
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) lines.push(`v ${p[i]} ${p[i + 1]} ${p[i + 2]}`);
  const ix = mesh.indices;
  for (let i = 0; i < ix.length; i += 3) lines.push(`f ${ix[i] + 1} ${ix[i + 1] + 1} ${ix[i + 2] + 1}`);
  return lines.join("\n") + "\n";
}
