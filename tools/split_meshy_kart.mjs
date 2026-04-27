import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const srcPath = join(root, 'assets', 'models', 'kart', 'meshy_go_kart.glb');
const outDir = join(root, 'assets', 'models', 'kart');

const wheelBoxes = {
  wheel_fl: { x: [-0.68, -0.12], y: [-0.56, 0.08], z: [0.28, 0.68] },
  wheel_fr: { x: [-0.68, -0.12], y: [-0.56, 0.08], z: [-0.68, -0.28] },
  wheel_bl: { x: [0.42, 0.96], y: [-0.56, 0.08], z: [0.28, 0.68] },
  wheel_br: { x: [0.42, 0.96], y: [-0.56, 0.08], z: [-0.68, -0.28] },
};

const glb = readFileSync(srcPath);
const { json, bin } = readGlb(glb);
const primitive = json.meshes[0].primitives[0];
const positions = readAccessor(json, bin, primitive.attributes.POSITION);
const normals = readAccessor(json, bin, primitive.attributes.NORMAL);
const uvs = readAccessor(json, bin, primitive.attributes.TEXCOORD_0);
const indices = readAccessor(json, bin, primitive.indices);

const triangles = {
  body: [],
  wheel_fl: [],
  wheel_fr: [],
  wheel_bl: [],
  wheel_br: [],
};

for (let i = 0; i < indices.length; i += 3) {
  const tri = [indices[i], indices[i + 1], indices[i + 2]];
  const centroid = [0, 0, 0];
  for (const vi of tri) {
    const p = positions[vi];
    centroid[0] += p[0] / 3;
    centroid[1] += p[1] / 3;
    centroid[2] += p[2] / 3;
  }
  let target = 'body';
  for (const [name, box] of Object.entries(wheelBoxes)) {
    if (inBox(centroid, box)) {
      target = name;
      break;
    }
  }
  triangles[target].push(tri);
}

for (const [name, tris] of Object.entries(triangles)) {
  const center = name === 'body' ? [0, 0, 0] : boundsCenter(tris, positions);
  const out = buildGlb(json, bin, primitive, tris, center);
  const outPath = join(outDir, name === 'body' ? 'meshy_go_kart_body.glb' : `meshy_go_kart_${name}.glb`);
  writeFileSync(outPath, out);
  console.log(name, tris.length, center.map((v) => Number(v.toFixed(6))).join(','));
}

function readGlb(buf) {
  if (buf.toString('utf8', 0, 4) !== 'glTF') {
    throw new Error('not a GLB');
  }
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < buf.length) {
    const length = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    offset += 8;
    const chunk = buf.subarray(offset, offset + length);
    if (type === 0x4e4f534a) {
      json = JSON.parse(chunk.toString('utf8').trim());
    } else if (type === 0x004e4942) {
      bin = chunk;
    }
    offset += length;
  }
  if (!json || !bin) {
    throw new Error('missing GLB chunks');
  }
  return { json, bin };
}

function readAccessor(json, bin, index) {
  const accessor = json.accessors[index];
  const view = json.bufferViews[accessor.bufferView];
  const count = componentCount(accessor.type);
  const size = componentSize(accessor.componentType);
  const stride = view.byteStride || count * size;
  const start = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const out = [];
  for (let i = 0; i < accessor.count; i++) {
    const values = [];
    const base = start + i * stride;
    for (let k = 0; k < count; k++) {
      values.push(readComponent(bin, base + k * size, accessor.componentType));
    }
    out.push(count === 1 ? values[0] : values);
  }
  return out;
}

function readComponent(buf, offset, type) {
  if (type === 5126) return buf.readFloatLE(offset);
  if (type === 5125) return buf.readUInt32LE(offset);
  if (type === 5123) return buf.readUInt16LE(offset);
  if (type === 5122) return buf.readInt16LE(offset);
  if (type === 5121) return buf.readUInt8(offset);
  if (type === 5120) return buf.readInt8(offset);
  throw new Error(`unsupported component type ${type}`);
}

function componentCount(type) {
  return { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
}

function componentSize(type) {
  return { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[type];
}

function inBox(point, box) {
  return point[0] >= box.x[0] && point[0] <= box.x[1] &&
    point[1] >= box.y[0] && point[1] <= box.y[1] &&
    point[2] >= box.z[0] && point[2] <= box.z[1];
}

function boundsCenter(tris, positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const tri of tris) {
    for (const vi of tri) {
      const p = positions[vi];
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[k]);
        max[k] = Math.max(max[k], p[k]);
      }
    }
  }
  return min.map((v, k) => (v + max[k]) * 0.5);
}

function buildGlb(sourceJson, sourceBin, primitive, tris, center) {
  const vertexMap = new Map();
  const outPositions = [];
  const outNormals = [];
  const outUvs = [];
  const outIndices = [];
  for (const tri of tris) {
    for (const vi of tri) {
      let outIndex = vertexMap.get(vi);
      if (outIndex === undefined) {
        outIndex = outPositions.length;
        vertexMap.set(vi, outIndex);
        const p = positions[vi];
        outPositions.push([p[0] - center[0], p[1] - center[1], p[2] - center[2]]);
        outNormals.push(normals[vi]);
        outUvs.push(uvs[vi]);
      }
      outIndices.push(outIndex);
    }
  }

  const buffers = [];
  const bufferViews = [];
  const accessors = [];
  const indexView = pushBuffer(bufferViews, buffers, writeUint32Array(outIndices), 34963);
  const positionView = pushBuffer(bufferViews, buffers, writeFloatArray(outPositions), 34962);
  const uvView = pushBuffer(bufferViews, buffers, writeFloatArray(outUvs), 34962);
  const normalView = pushBuffer(bufferViews, buffers, writeFloatArray(outNormals), 34962);

  accessors.push(accessor(positionView, 5126, outPositions.length, 'VEC3', minVec(outPositions), maxVec(outPositions)));
  accessors.push(accessor(uvView, 5126, outUvs.length, 'VEC2', minVec(outUvs), maxVec(outUvs)));
  accessors.push(accessor(normalView, 5126, outNormals.length, 'VEC3', minVec(outNormals), maxVec(outNormals)));
  accessors.push(accessor(indexView, 5125, outIndices.length, 'SCALAR', [Math.min(...outIndices)], [Math.max(...outIndices)]));

  const images = deepClone(sourceJson.images || []);
  for (const image of images) {
    const sourceView = sourceJson.bufferViews[image.bufferView];
    const start = sourceView.byteOffset || 0;
    const bytes = sourceBin.subarray(start, start + sourceView.byteLength);
    image.bufferView = pushBuffer(bufferViews, buffers, Buffer.from(bytes));
  }

  const json = {
    asset: { version: '2.0', generator: 'MarbleRush Meshy kart splitter' },
    scenes: [{ nodes: [0] }],
    scene: 0,
    nodes: [{ mesh: 0 }],
    meshes: [{
      primitives: [{
        attributes: { POSITION: 0, TEXCOORD_0: 1, NORMAL: 2 },
        indices: 3,
        material: primitive.material ?? 0,
        mode: primitive.mode ?? 4,
      }],
    }],
    materials: deepClone(sourceJson.materials || []),
    textures: deepClone(sourceJson.textures || []),
    samplers: deepClone(sourceJson.samplers || []),
    images,
    accessors,
    bufferViews,
    buffers: [{ byteLength: buffers.reduce((sum, part) => sum + part.length, 0) }],
  };
  return encodeGlb(json, Buffer.concat(buffers));
}

function pushBuffer(bufferViews, buffers, data, target = undefined) {
  const offset = buffers.reduce((sum, part) => sum + part.length, 0);
  const view = { buffer: 0, byteOffset: offset, byteLength: data.length };
  if (target) view.target = target;
  bufferViews.push(view);
  buffers.push(pad4(data));
  return bufferViews.length - 1;
}

function accessor(bufferView, componentType, count, type, min, max) {
  return { bufferView, byteOffset: 0, componentType, normalized: false, count, type, min, max };
}

function writeFloatArray(rows) {
  const width = Array.isArray(rows[0]) ? rows[0].length : 1;
  const out = Buffer.alloc(rows.length * width * 4);
  let offset = 0;
  for (const row of rows) {
    const values = Array.isArray(row) ? row : [row];
    for (const value of values) {
      out.writeFloatLE(value, offset);
      offset += 4;
    }
  }
  return out;
}

function writeUint32Array(values) {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => out.writeUInt32LE(value, i * 4));
  return out;
}

function minVec(rows) {
  const width = Array.isArray(rows[0]) ? rows[0].length : 1;
  const out = Array(width).fill(Infinity);
  for (const row of rows) {
    const values = Array.isArray(row) ? row : [row];
    for (let i = 0; i < width; i++) out[i] = Math.min(out[i], values[i]);
  }
  return out;
}

function maxVec(rows) {
  const width = Array.isArray(rows[0]) ? rows[0].length : 1;
  const out = Array(width).fill(-Infinity);
  for (const row of rows) {
    const values = Array.isArray(row) ? row : [row];
    for (let i = 0; i < width; i++) out[i] = Math.max(out[i], values[i]);
  }
  return out;
}

function encodeGlb(json, bin) {
  const jsonBytes = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const binBytes = pad4(bin);
  const total = 12 + 8 + jsonBytes.length + 8 + binBytes.length;
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 4, 'utf8');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  return Buffer.concat([header, chunk(jsonBytes, 0x4e4f534a), chunk(binBytes, 0x004e4942)]);
}

function chunk(data, type) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(data.length, 0);
  header.writeUInt32LE(type, 4);
  return Buffer.concat([header, data]);
}

function pad4(data, pad = 0) {
  const extra = (4 - (data.length % 4)) % 4;
  if (extra === 0) return data;
  return Buffer.concat([data, Buffer.alloc(extra, pad)]);
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}
