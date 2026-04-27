import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'assets', 'models', 'kart');
mkdirSync(outDir, { recursive: true });

const materials = {
  toyBlue: material('glossy toy blue plastic', [0.015, 0.34, 1.0, 1], { roughness: 0.32 }),
  toyLightBlue: material('glossy sky blue plastic', [0.08, 0.68, 1.0, 1], { roughness: 0.30 }),
  toyOrange: material('glossy orange plastic', [1.0, 0.34, 0.055, 1], { roughness: 0.34 }),
  toyWhite: material('warm white plastic', [0.98, 0.96, 0.88, 1], { roughness: 0.42 }),
  toyRed: material('glossy red plastic', [0.98, 0.075, 0.055, 1], { roughness: 0.36 }),
  blackPlastic: material('soft black plastic', [0.018, 0.022, 0.028, 1], { roughness: 0.58 }),
  tire: material('matte rubber tire', [0.006, 0.0065, 0.0075, 1], { roughness: 0.92 }),
  rubberEdge: material('worn rubber edge', [0.052, 0.055, 0.058, 1], { roughness: 0.86 }),
  metal: material('brushed toy metal', [0.78, 0.74, 0.62, 1], { metallic: 0.62, roughness: 0.27 }),
  glass: material('smoked glossy visor', [0.035, 0.13, 0.22, 1], { roughness: 0.18, emissive: [0.0, 0.025, 0.05] }),
  skin: material('warm driver face', [1.0, 0.72, 0.52, 1], { roughness: 0.55 }),
};

function material(name, color, opts = {}) {
  return {
    name,
    color,
    metallic: opts.metallic ?? 0,
    roughness: opts.roughness ?? 0.55,
    emissive: opts.emissive,
  };
}

class MeshBuilder {
  constructor() {
    this.primitives = [];
  }

  addBox(center, size, material) {
    const x0 = center.x - size.x * 0.5;
    const x1 = center.x + size.x * 0.5;
    const y0 = center.y - size.y * 0.5;
    const y1 = center.y + size.y * 0.5;
    const z0 = center.z - size.z * 0.5;
    const z1 = center.z + size.z * 0.5;
    const quads = [
      [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]],
      [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
      [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
      [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]],
      [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]],
      [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
    ];
    for (const corners of quads) this.addQuad(corners, material);
  }

  addChamferedBox(center, size, bevel, material) {
    const hx = size.x * 0.5;
    const hy = size.y * 0.5;
    const hz = size.z * 0.5;
    const b = Math.max(0, Math.min(bevel, hx * 0.45, hy * 0.45, hz * 0.45));
    if (b <= 0.0001) {
      this.addBox(center, size, material);
      return;
    }
    const local = (x, y, z) => [center.x + x, center.y + y, center.z + z];

    for (const sx of [-1, 1]) {
      this.addPolygon([
        local(sx * hx, -hy + b, -hz + b),
        local(sx * hx, hy - b, -hz + b),
        local(sx * hx, hy - b, hz - b),
        local(sx * hx, -hy + b, hz - b),
      ], material, center);
    }
    for (const sy of [-1, 1]) {
      this.addPolygon([
        local(-hx + b, sy * hy, -hz + b),
        local(-hx + b, sy * hy, hz - b),
        local(hx - b, sy * hy, hz - b),
        local(hx - b, sy * hy, -hz + b),
      ], material, center);
    }
    for (const sz of [-1, 1]) {
      this.addPolygon([
        local(-hx + b, -hy + b, sz * hz),
        local(hx - b, -hy + b, sz * hz),
        local(hx - b, hy - b, sz * hz),
        local(-hx + b, hy - b, sz * hz),
      ], material, center);
    }

    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        this.addPolygon([
          local(sx * hx, sy * (hy - b), -hz + b),
          local(sx * hx, sy * (hy - b), hz - b),
          local(sx * (hx - b), sy * hy, hz - b),
          local(sx * (hx - b), sy * hy, -hz + b),
        ], material, center);
      }
      for (const sz of [-1, 1]) {
        this.addPolygon([
          local(sx * hx, -hy + b, sz * (hz - b)),
          local(sx * hx, hy - b, sz * (hz - b)),
          local(sx * (hx - b), hy - b, sz * hz),
          local(sx * (hx - b), -hy + b, sz * hz),
        ], material, center);
      }
    }
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        this.addPolygon([
          local(-hx + b, sy * hy, sz * (hz - b)),
          local(hx - b, sy * hy, sz * (hz - b)),
          local(hx - b, sy * (hy - b), sz * hz),
          local(-hx + b, sy * (hy - b), sz * hz),
        ], material, center);
      }
    }
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          this.addPolygon([
            local(sx * hx, sy * (hy - b), sz * (hz - b)),
            local(sx * (hx - b), sy * hy, sz * (hz - b)),
            local(sx * (hx - b), sy * (hy - b), sz * hz),
          ], material, center);
        }
      }
    }
  }

  addOrientedBox(center, axes, halfSize, material) {
    const corners = [];
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          corners.push([
            center.x + axes.x[0] * halfSize.x * sx + axes.y[0] * halfSize.y * sy + axes.z[0] * halfSize.z * sz,
            center.y + axes.x[1] * halfSize.x * sx + axes.y[1] * halfSize.y * sy + axes.z[1] * halfSize.z * sz,
            center.z + axes.x[2] * halfSize.x * sx + axes.y[2] * halfSize.y * sy + axes.z[2] * halfSize.z * sz,
          ]);
        }
      }
    }
    const at = (sx, sy, sz) => corners[((sx > 0 ? 1 : 0) * 4) + ((sy > 0 ? 1 : 0) * 2) + (sz > 0 ? 1 : 0)];
    const faces = [
      [at(1, -1, -1), at(1, -1, 1), at(1, 1, 1), at(1, 1, -1)],
      [at(-1, -1, 1), at(-1, -1, -1), at(-1, 1, -1), at(-1, 1, 1)],
      [at(-1, 1, -1), at(1, 1, -1), at(1, 1, 1), at(-1, 1, 1)],
      [at(-1, -1, 1), at(1, -1, 1), at(1, -1, -1), at(-1, -1, -1)],
      [at(-1, -1, 1), at(-1, 1, 1), at(1, 1, 1), at(1, -1, 1)],
      [at(1, -1, -1), at(1, 1, -1), at(-1, 1, -1), at(-1, -1, -1)],
    ];
    for (const face of faces) this.addPolygon(face, material, center);
  }

  addWedge({ x0, x1, z0, z1, bottom, topFront, topBack }, material) {
    const v = [
      [x0, bottom, z0], [x1, bottom, z0], [x1, bottom, z1], [x0, bottom, z1],
      [x0, topFront, z0], [x1, topFront, z0], [x1, topBack, z1], [x0, topBack, z1],
    ];
    this.addQuad([v[1], v[0], v[4], v[5]], material);
    this.addQuad([v[3], v[2], v[6], v[7]], material);
    this.addQuad([v[0], v[3], v[7], v[4]], material);
    this.addQuad([v[2], v[1], v[5], v[6]], material);
    this.addQuad([v[4], v[7], v[6], v[5]], material);
    this.addQuad([v[0], v[1], v[2], v[3]], material);
  }

  addCylinderX(center, radius, length, segments, material) {
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    const half = length * 0.5;

    for (let i = 0; i <= segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      const y = Math.sin(t) * radius;
      const z = Math.cos(t) * radius;
      positions.push(center.x - half, center.y + y, center.z + z);
      positions.push(center.x + half, center.y + y, center.z + z);
      normals.push(0, Math.sin(t), Math.cos(t), 0, Math.sin(t), Math.cos(t));
      uvs.push(0, i / segments, 1, i / segments);
    }
    for (let i = 0; i < segments; i++) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      indices.push(a, b, c, b, d, c);
    }
    this.addPrimitive(positions, normals, uvs, indices, material);

    this.addCapX(center.x - half, center.y, center.z, -1, radius, segments, material);
    this.addCapX(center.x + half, center.y, center.z, 1, radius, segments, material);
  }

  addCapX(x, y, z, side, radius, segments, material) {
    const positions = [x, y, z];
    const normals = [side, 0, 0];
    const uvs = [0.5, 0.5];
    const indices = [];
    for (let i = 0; i <= segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      positions.push(x, y + Math.sin(t) * radius, z + Math.cos(t) * radius);
      normals.push(side, 0, 0);
      uvs.push(0.5 + Math.sin(t) * 0.5, 0.5 + Math.cos(t) * 0.5);
    }
    for (let i = 1; i <= segments; i++) {
      if (side < 0) {
        indices.push(0, i, i + 1);
      } else {
        indices.push(0, i + 1, i);
      }
    }
    this.addPrimitive(positions, normals, uvs, indices, material);
  }

  addSphere(center, radius, segments, rings, material) {
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    for (let j = 0; j <= rings; j++) {
      const v = j / rings;
      const phi = v * Math.PI;
      const y = Math.cos(phi);
      const r = Math.sin(phi);
      for (let i = 0; i <= segments; i++) {
        const u = i / segments;
        const theta = u * Math.PI * 2;
        const nx = Math.cos(theta) * r;
        const ny = y;
        const nz = Math.sin(theta) * r;
        positions.push(center.x + nx * radius, center.y + ny * radius, center.z + nz * radius);
        normals.push(nx, ny, nz);
        uvs.push(u, v);
      }
    }
    const stride = segments + 1;
    for (let j = 0; j < rings; j++) {
      for (let i = 0; i < segments; i++) {
        const a = j * stride + i;
        const b = a + 1;
        const c = (j + 1) * stride + i;
        const d = c + 1;
        pushOriented(indices, positions, a, c, b, center);
        pushOriented(indices, positions, b, c, d, center);
      }
    }
    this.addPrimitive(positions, normals, uvs, indices, material);
  }

  addQuad(corners, material) {
    const normal = faceNormal(corners[0], corners[1], corners[2]);
    this.addPrimitive(
      corners.flat(),
      [normal, normal, normal, normal].flat(),
      [0, 0, 1, 0, 1, 1, 0, 1],
      [0, 1, 2, 0, 2, 3],
      material,
    );
  }

  addPolygon(corners, material, outwardCenter) {
    if (corners.length < 3) return;
    let normal = faceNormal(corners[0], corners[1], corners[2]);
    const mid = corners.reduce((acc, p) => ({ x: acc.x + p[0], y: acc.y + p[1], z: acc.z + p[2] }), { x: 0, y: 0, z: 0 });
    mid.x /= corners.length;
    mid.y /= corners.length;
    mid.z /= corners.length;
    const away = { x: mid.x - outwardCenter.x, y: mid.y - outwardCenter.y, z: mid.z - outwardCenter.z };
    let ordered = corners;
    if (dot({ x: normal[0], y: normal[1], z: normal[2] }, away) < 0) {
      ordered = [...corners].reverse();
      normal = faceNormal(ordered[0], ordered[1], ordered[2]);
    }
    const positions = ordered.flat();
    const normals = Array.from({ length: ordered.length }, () => normal).flat();
    const uvs = ordered.flatMap((_, i) => [i % 2, i > 1 ? 1 : 0]);
    const indices = [];
    for (let i = 1; i < ordered.length - 1; i++) indices.push(0, i, i + 1);
    this.addPrimitive(positions, normals, uvs, indices, material);
  }

  addPrimitive(positions, normals, uvs, indices, material) {
    this.primitives.push({
      positions: Float32Array.from(positions),
      normals: Float32Array.from(normals),
      uvs: Float32Array.from(uvs),
      indices: Uint32Array.from(indices),
      material,
    });
  }
}

function pushOriented(indices, positions, a, b, c, center) {
  const pa = vecAt(positions, a);
  const pb = vecAt(positions, b);
  const pc = vecAt(positions, c);
  const n = cross(sub(pb, pa), sub(pc, pa));
  const mid = scale(add(add(pa, pb), pc), 1 / 3);
  if (dot(n, sub(mid, center)) < 0) {
    indices.push(a, c, b);
  } else {
    indices.push(a, b, c);
  }
}

function vecAt(values, index) {
  const i = index * 3;
  return { x: values[i], y: values[i + 1], z: values[i + 2] };
}

function faceNormal(a, b, c) {
  const n = cross(
    { x: b[0] - a[0], y: b[1] - a[1], z: b[2] - a[2] },
    { x: c[0] - a[0], y: c[1] - a[1], z: c[2] - a[2] },
  );
  return normalize(n);
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale(a, s) {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

function cross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalize(a) {
  const len = Math.hypot(a.x, a.y, a.z) || 1;
  return [a.x / len, a.y / len, a.z / len];
}

function makeKartBody() {
  const b = new MeshBuilder();
  b.addChamferedBox({ x: 0, y: 0.04, z: 0.04 }, { x: 1.66, y: 0.46, z: 2.3 }, 0.08, materials.toyBlue);
  b.addChamferedBox({ x: 0, y: -0.22, z: 0.04 }, { x: 1.4, y: 0.18, z: 2.08 }, 0.045, materials.blackPlastic);
  b.addWedge({ x0: -0.66, x1: 0.66, z0: -1.58, z1: -0.54, bottom: 0.04, topFront: 0.2, topBack: 0.56 }, materials.toyOrange);
  b.addChamferedBox({ x: 0, y: 0.43, z: -0.76 }, { x: 1.32, y: 0.12, z: 0.2 }, 0.035, materials.toyWhite);
  b.addChamferedBox({ x: -0.48, y: 0.49, z: -1.03 }, { x: 0.18, y: 0.08, z: 0.42 }, 0.025, materials.toyWhite);
  b.addChamferedBox({ x: 0.48, y: 0.49, z: -1.03 }, { x: 0.18, y: 0.08, z: 0.42 }, 0.025, materials.toyWhite);
  b.addChamferedBox({ x: 0, y: 0.58, z: 0.12 }, { x: 0.84, y: 0.56, z: 0.72 }, 0.075, materials.toyOrange);
  b.addWedge({ x0: -0.48, x1: 0.48, z0: -0.36, z1: 0.04, bottom: 0.54, topFront: 0.9, topBack: 0.68 }, materials.glass);
  b.addSphere({ x: 0, y: 0.94, z: 0.0 }, 0.29, 18, 9, materials.toyWhite);
  b.addWedge({ x0: -0.2, x1: 0.2, z0: -0.29, z1: -0.12, bottom: 0.85, topFront: 0.97, topBack: 0.91 }, materials.glass);
  b.addChamferedBox({ x: -0.72, y: 0.08, z: -0.78 }, { x: 0.24, y: 0.2, z: 0.56 }, 0.04, materials.toyOrange);
  b.addChamferedBox({ x: 0.72, y: 0.08, z: -0.78 }, { x: 0.24, y: 0.2, z: 0.56 }, 0.04, materials.toyOrange);
  b.addChamferedBox({ x: -0.72, y: 0.08, z: 0.84 }, { x: 0.24, y: 0.2, z: 0.58 }, 0.04, materials.toyOrange);
  b.addChamferedBox({ x: 0.72, y: 0.08, z: 0.84 }, { x: 0.24, y: 0.2, z: 0.58 }, 0.04, materials.toyOrange);
  b.addChamferedBox({ x: 0, y: 0.64, z: 1.33 }, { x: 1.86, y: 0.12, z: 0.24 }, 0.045, materials.toyOrange);
  b.addChamferedBox({ x: -0.62, y: 0.42, z: 1.26 }, { x: 0.11, y: 0.42, z: 0.1 }, 0.025, materials.blackPlastic);
  b.addChamferedBox({ x: 0.62, y: 0.42, z: 1.26 }, { x: 0.11, y: 0.42, z: 0.1 }, 0.025, materials.blackPlastic);
  b.addChamferedBox({ x: 0, y: 0.04, z: -1.45 }, { x: 1.82, y: 0.15, z: 0.18 }, 0.045, materials.blackPlastic);
  b.addChamferedBox({ x: 0, y: 0.04, z: 1.38 }, { x: 1.48, y: 0.14, z: 0.16 }, 0.04, materials.blackPlastic);
  b.addCylinderX({ x: -0.46, y: -0.02, z: 1.5 }, 0.1, 0.36, 16, materials.metal);
  b.addCylinderX({ x: 0.46, y: -0.02, z: 1.5 }, 0.1, 0.36, 16, materials.metal);
  return encodeGlb(b.primitives, 'MarbleRush cartoon kart body');
}

function makeKartWheel() {
  const b = new MeshBuilder();
  b.addCylinderX({ x: 0, y: 0, z: 0 }, 0.44, 0.42, 32, materials.tire);
  b.addCylinderX({ x: 0, y: 0, z: 0 }, 0.35, 0.45, 32, materials.rubberEdge);
  b.addCylinderX({ x: -0.24, y: 0, z: 0 }, 0.29, 0.055, 32, materials.toyOrange);
  b.addCylinderX({ x: 0.24, y: 0, z: 0 }, 0.29, 0.055, 32, materials.toyOrange);
  b.addCylinderX({ x: 0, y: 0, z: 0 }, 0.18, 0.48, 24, materials.metal);
  addWheelSpokes(b, -0.275);
  addWheelSpokes(b, 0.275);
  return encodeGlb(b.primitives, 'MarbleRush cartoon kart wheel');
}

function addWheelSpokes(builder, x) {
  const axesX = [1, 0, 0];
  for (let i = 0; i < 3; i++) {
    const angle = i * Math.PI * 2 / 3 + 0.28;
    const radial = [0, Math.sin(angle), Math.cos(angle)];
    const tangent = [0, Math.cos(angle), -Math.sin(angle)];
    builder.addOrientedBox({
      x,
      y: radial[1] * 0.17,
      z: radial[2] * 0.17,
    }, {
      x: axesX,
      y: radial,
      z: tangent,
    }, {
      x: 0.018,
      y: 0.13,
      z: 0.035,
    }, materials.toyWhite);
  }
}

function encodeGlb(primitives, generator) {
  const mergedPrimitives = mergePrimitivesByMaterial(primitives);
  const buffers = [];
  const views = [];
  const accessors = [];
  const materialDefs = [];
  const primitiveDefs = [];

  function materialIndex(mat) {
    const key = mat.name ?? JSON.stringify(mat);
    let index = materialDefs.findIndex((candidate) => candidate.key === key);
    if (index < 0) {
      index = materialDefs.length;
      materialDefs.push({ key, material: mat });
    }
    return index;
  }

  function addTypedArray(array, target, type, componentType, count, min, max) {
    const byteOffset = buffers.reduce((sum, part) => sum + part.length, 0);
    const data = Buffer.from(array.buffer);
    buffers.push(data, Buffer.alloc((4 - (data.length % 4)) % 4));
    const viewIndex = views.length;
    views.push({ buffer: 0, byteOffset, byteLength: data.length, target });
    const accessor = { bufferView: viewIndex, byteOffset: 0, componentType, count, type };
    if (min) accessor.min = min;
    if (max) accessor.max = max;
    const accessorIndex = accessors.length;
    accessors.push(accessor);
    return accessorIndex;
  }

  for (const primitive of mergedPrimitives) {
    const bounds = positionBounds(primitive.positions);
    const position = addTypedArray(primitive.positions, 34962, 'VEC3', 5126, primitive.positions.length / 3, bounds.min, bounds.max);
    const normal = addTypedArray(primitive.normals, 34962, 'VEC3', 5126, primitive.normals.length / 3);
    const uv = addTypedArray(primitive.uvs, 34962, 'VEC2', 5126, primitive.uvs.length / 2);
    const index = addTypedArray(primitive.indices, 34963, 'SCALAR', 5125, primitive.indices.length);
    primitiveDefs.push({
      attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: uv },
      indices: index,
      material: materialIndex(primitive.material),
    });
  }

  const bin = Buffer.concat(buffers);
  const json = {
    asset: { version: '2.0', generator },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: primitiveDefs }],
    materials: materialDefs.map(({ material: mat }) => {
      const out = {
        name: mat.name,
        pbrMetallicRoughness: {
          baseColorFactor: mat.color,
          roughnessFactor: mat.roughness,
          metallicFactor: mat.metallic,
        },
        doubleSided: true,
      };
      if (mat.emissive) {
        out.emissiveFactor = mat.emissive;
      }
      return out;
    }),
    buffers: [{ byteLength: bin.length }],
    bufferViews: views,
    accessors,
  };

  const jsonChunk = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const binChunk = pad4(bin, 0);
  const length = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(length, 8);
  return Buffer.concat([header, glbChunk(jsonChunk, 0x4e4f534a), glbChunk(binChunk, 0x004e4942)]);
}

function mergePrimitivesByMaterial(primitives) {
  const groups = [];
  const byKey = new Map();

  function keyFor(mat) {
    return mat.name ?? JSON.stringify(mat);
  }

  for (const primitive of primitives) {
    const key = keyFor(primitive.material);
    let group = byKey.get(key);
    if (!group) {
      group = {
        material: primitive.material,
        positions: [],
        normals: [],
        uvs: [],
        indices: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    const vertexOffset = group.positions.length / 3;
    for (const value of primitive.positions) group.positions.push(value);
    for (const value of primitive.normals) group.normals.push(value);
    for (const value of primitive.uvs) group.uvs.push(value);
    for (const value of primitive.indices) group.indices.push(value + vertexOffset);
  }

  return groups.map((group) => ({
    positions: Float32Array.from(group.positions),
    normals: Float32Array.from(group.normals),
    uvs: Float32Array.from(group.uvs),
    indices: Uint32Array.from(group.indices),
    material: group.material,
  }));
}

function positionBounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], positions[i + axis]);
      max[axis] = Math.max(max[axis], positions[i + axis]);
    }
  }
  return { min, max };
}

function glbChunk(data, type) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(data.length, 0);
  header.writeUInt32LE(type, 4);
  return Buffer.concat([header, data]);
}

function pad4(buffer, fill) {
  const pad = (4 - (buffer.length % 4)) % 4;
  return pad === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(pad, fill)]);
}

writeFileSync(join(outDir, 'kart_body.glb'), makeKartBody());
writeFileSync(join(outDir, 'kart_wheel.glb'), makeKartWheel());
console.log(`generated ${outDir}`);
