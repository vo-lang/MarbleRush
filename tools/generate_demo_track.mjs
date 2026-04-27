import { deflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'assets', 'maps', 'demo_track');
const audioDir = join(root, 'assets', 'audio');
mkdirSync(outDir, { recursive: true });
mkdirSync(audioDir, { recursive: true });

const terrainWidth = 280;
const terrainDepth = 240;
const terrainHeight = 8;
const terrainY = -1.0;
const heightmapSize = 257;
const trackWidth = 15.5;
const trackClearance = 0.055;
const shoulderWidth = 7.0;
const shoulderDrop = 0.18;
const terrainBlendWidth = 18.0;
const samples = 192;
const gateCount = 8;
const trackTextureWidth = 512;
const trackTextureHeight = 2048;
const kartSpawnYOffset = 1.18;

function centerAt(t) {
  return {
    x: 72 * Math.sin(t) + 18 * Math.sin(2 * t),
    z: 82 * Math.cos(t) - 12 * Math.cos(3 * t),
    y: 0.92 + 0.42 * Math.sin(t + 0.7) + 0.2 * Math.sin(2 * t - 0.2),
  };
}

function tangentAt(t) {
  const e = 0.001;
  const a = centerAt(t - e);
  const b = centerAt(t + e);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len };
}

const centerline = Array.from({ length: samples }, (_, i) => {
  const t = (i / samples) * Math.PI * 2;
  const p = centerAt(t);
  const tan = tangentAt(t);
  return { ...p, t, tan };
});

function nearestRoad(x, z) {
  let best = centerline[0];
  let bestD = Infinity;
  for (const p of centerline) {
    const d = Math.hypot(x - p.x, z - p.z);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return { point: best, distance: bestD };
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function terrainWorldY(x, z) {
  const n = nearestRoad(x, z);
  const hill =
    1.1 +
    0.55 * Math.sin((x + 26) / 42) * Math.cos((z - 8) / 51) +
    0.24 * Math.sin((x - z) / 29);
  const halfTrack = trackWidth * 0.5;
  const shoulderT = smoothstep(halfTrack, halfTrack + shoulderWidth, n.distance);
  const roadShoulder = n.point.y - trackClearance - shoulderT * shoulderDrop;
  const blend = smoothstep(halfTrack + shoulderWidth, halfTrack + shoulderWidth + terrainBlendWidth, n.distance);
  return roadShoulder * (1 - blend) + hill * blend;
}

function makeHeightmap() {
  return makeHeightmapRegion(0, 0, terrainWidth, terrainDepth);
}

function makeHeightmapRegion(centerX, centerZ, width, depth) {
  const pixels = Buffer.alloc(heightmapSize * heightmapSize);
  for (let row = 0; row < heightmapSize; row++) {
    const z = centerZ + (row / (heightmapSize - 1) - 0.5) * depth;
    for (let col = 0; col < heightmapSize; col++) {
      const x = centerX + (col / (heightmapSize - 1) - 0.5) * width;
      const y = terrainWorldY(x, z);
      const h = Math.max(0, Math.min(1, (y - terrainY) / terrainHeight));
      pixels[row * heightmapSize + col] = Math.round(h * 255);
    }
  }
  return encodePngGray(heightmapSize, heightmapSize, pixels);
}

function encodePngGray(width, height, pixels) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let row = 0; row < height; row++) {
    raw[row * (width + 1)] = 0;
    pixels.copy(raw, row * (width + 1) + 1, row * width, (row + 1) * width);
  }
  const chunks = [
    chunk('IHDR', Buffer.concat([
      u32(width),
      u32(height),
      Buffer.from([8, 0, 0, 0, 0]),
    ])),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ];
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
}

function encodePngRgba(width, height, pixels) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row++) {
    const rowStart = row * (width * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, row * width * 4, (row + 1) * width * 4);
  }
  const chunks = [
    chunk('IHDR', Buffer.concat([
      u32(width),
      u32(height),
      Buffer.from([8, 6, 0, 0, 0]),
    ])),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ];
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  return Buffer.concat([u32(data.length), name, data, u32(crc32(Buffer.concat([name, data])))]);
}

function u32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0);
  return b;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function textureNoise(x, y) {
  let n = (x * 374761393 + y * 668265263) >>> 0;
  n = ((n ^ (n >>> 13)) * 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) & 255) / 255;
}

function mixColor(a, b, t) {
  return [
    a[0] * (1 - t) + b[0] * t,
    a[1] * (1 - t) + b[1] * t,
    a[2] * (1 - t) + b[2] * t,
  ];
}

function putPixel(pixels, index, color) {
  pixels[index] = Math.max(0, Math.min(255, Math.round(color[0])));
  pixels[index + 1] = Math.max(0, Math.min(255, Math.round(color[1])));
  pixels[index + 2] = Math.max(0, Math.min(255, Math.round(color[2])));
  pixels[index + 3] = 255;
}

function makeTrackTexture() {
  const pixels = Buffer.alloc(trackTextureWidth * trackTextureHeight * 4);
  for (let y = 0; y < trackTextureHeight; y++) {
    const v = (y + 0.5) / trackTextureHeight;
    const dash = Math.floor(v * 88) % 2;
    for (let x = 0; x < trackTextureWidth; x++) {
      const u = (x + 0.5) / trackTextureWidth;
      const fine = textureNoise(x, y) - 0.5;
      const grain = textureNoise(Math.floor(x / 4), Math.floor(y / 4)) - 0.5;
      const laneWear =
        0.5 + 0.5 * Math.sin(v * Math.PI * 42 + Math.sin(u * Math.PI * 10) * 0.55);
      let color = [151 + fine * 12 + grain * 7, 164 + fine * 11 + grain * 6, 168 + fine * 10 + grain * 6];

      const tireLeft = Math.abs(u - (0.34 + Math.sin(v * Math.PI * 12) * 0.015));
      const tireRight = Math.abs(u - (0.66 + Math.cos(v * Math.PI * 10) * 0.015));
      if (tireLeft < 0.028 || tireRight < 0.028) {
        color = mixColor(color, [88, 102, 106], 0.2 + laneWear * 0.14);
      }

      const edge = Math.min(u, 1 - u);
      if (edge < 0.075) {
        const block = Math.floor(v * 72);
        const redBlock = (block + (u > 0.5 ? 1 : 0)) % 2 === 0;
        color = redBlock ? [204, 38, 35] : [226, 231, 220];
        color = mixColor(color, [124, 138, 143], Math.max(0, edge - 0.055) * 10);
      } else if (edge < 0.105) {
        color = mixColor(color, [232, 237, 225], 0.92);
      }

      const centerLeft = Math.abs(u - 0.485);
      const centerRight = Math.abs(u - 0.515);
      if (centerLeft < 0.009 || centerRight < 0.009) {
        color = mixColor(color, dash === 0 ? [248, 196, 46] : [170, 138, 58], 0.9);
      }

      const shoulderShade = smoothstep(0.72, 0.94, Math.abs(u - 0.5) * 2);
      color = mixColor(color, [116, 132, 137], shoulderShade * 0.16);
      putPixel(pixels, (y * trackTextureWidth + x) * 4, color);
    }
  }
  return encodePngRgba(trackTextureWidth, trackTextureHeight, pixels);
}

function trackLoopLength() {
  const distances = trackDistances();
  return distances[distances.length - 1];
}

function trackDistances() {
  let distance = 0;
  let previous = centerline[0];
  const distances = [0];
  for (let i = 1; i <= samples; i++) {
    const p = centerline[i % samples];
    distance += Math.hypot(p.x - previous.x, p.z - previous.z);
    distances.push(distance);
    previous = p;
  }
  return distances;
}

function trackPointAtDistance(distance) {
  const distances = trackDistances();
  const total = distances[distances.length - 1];
  const d = ((distance % total) + total) % total;
  for (let i = 0; i < samples; i++) {
    const start = distances[i];
    const end = distances[i + 1];
    if (d > end && i < samples - 1) continue;
    const a = centerline[i];
    const b = centerline[(i + 1) % samples];
    const span = Math.max(0.0001, end - start);
    const t = Math.max(0, Math.min(1, (d - start) / span));
    const tan = tangentAt(a.t * (1 - t) + b.t * t);
    return {
      x: a.x * (1 - t) + b.x * t,
      y: a.y * (1 - t) + b.y * t,
      z: a.z * (1 - t) + b.z * t,
      tan,
    };
  }
  return centerline[0];
}

function yawFromTangent(tan) {
  return Math.atan2(-tan.x, -tan.z);
}

function makeTrackCenterline() {
  return [...centerline, centerline[0]].map((p, index) => ({
    name: `cp_${String(index).padStart(3, '0')}`,
    position: { x: p.x, y: p.y, z: p.z },
    width: trackWidth,
    bank: 0.045 * Math.sin(p.t * 2.0 - 0.4),
  }));
}

function makeTrackGates(totalDistance) {
  return Array.from({ length: gateCount }, (_, i) => {
    const distance = (totalDistance * (i + 1)) / gateCount;
    return {
      name: i === gateCount - 1 ? 'Finish' : `Gate ${i + 1}`,
      distance,
      width: trackWidth + 4.0,
      radius: Math.max(11.0, trackWidth * 0.78),
    };
  });
}

function makeTrackRespawns(totalDistance) {
  return Array.from({ length: gateCount }, (_, i) => {
    const distance = (totalDistance * i) / gateCount;
    const p = trackPointAtDistance(distance);
    return {
      name: i === 0 ? 'start_respawn' : `respawn_${i}`,
      distance,
      position: { x: p.x, y: p.y + kartSpawnYOffset, z: p.z },
      yaw: yawFromTangent(p.tan),
    };
  });
}

function makeTerrainChunks() {
  const chunkW = terrainWidth * 0.5;
  const chunkD = terrainDepth * 0.5;
  const chunks = [];
  for (const zSign of [-1, 1]) {
    for (const xSign of [-1, 1]) {
      const name = `${zSign < 0 ? 'north' : 'south'}_${xSign < 0 ? 'west' : 'east'}`;
      chunks.push({
        tag: `terrain_${name}`,
        heightmap: `heightmap_${name}.png`,
        position: { x: xSign * chunkW * 0.5, y: terrainY, z: zSign * chunkD * 0.5 },
        width: chunkW,
        height: terrainHeight,
        depth: chunkD,
        uvScale: 12,
        tintSet: true,
        tint: { r: 0.43, g: 0.78, b: 0.38, a: 1 },
        friction: 0.92,
      });
    }
  }
  return chunks;
}

function makeRacingLines(totalDistance) {
  const count = 48;
  const points = Array.from({ length: count + 1 }, (_, i) => {
    const distance = (totalDistance * i) / count;
    const phase = (i / count) * Math.PI * 2;
    return {
      distance,
      lateral: Math.sin(phase * 2.0 + 0.4) * trackWidth * 0.18,
      targetSpeed: 24 + 7 * (0.5 + 0.5 * Math.cos(phase * 3.0 - 0.6)),
    };
  });
  return [{ name: 'optimal', points }];
}

function makeTrackSurfaces(totalDistance) {
  const half = trackWidth * 0.5;
  return [{
    name: 'asphalt',
    kind: 'road',
    start: 0,
    end: 0,
    left: -half,
    right: half,
    priority: 0,
    friction: 1.0,
  }, {
    name: 'boost_lane',
    kind: 'road',
    start: totalDistance * 0.18,
    end: totalDistance * 0.235,
    left: -3.3,
    right: 3.3,
    priority: 4,
    friction: 1.08,
    boost: 1.25,
  }, {
    name: 'left_grass',
    kind: 'offroad',
    start: 0,
    end: 0,
    left: -half - shoulderWidth - terrainBlendWidth,
    right: -half,
    priority: 1,
    friction: 0.62,
  }, {
    name: 'right_grass',
    kind: 'offroad',
    start: 0,
    end: 0,
    left: half,
    right: half + shoulderWidth + terrainBlendWidth,
    priority: 1,
    friction: 0.62,
  }];
}

function makeTrackVisualGlb(trackTexture) {
 const half = trackWidth * 0.5;
  return encodeGlb({
    primitives: [makeTrackRibbon(-half, half, 0.0, 0)],
    materials: [{ color: [1.0, 1.0, 1.0, 1.0], texture: 0 }],
    images: [{ mimeType: 'image/png', data: trackTexture }],
    textures: [{ source: 0 }],
  });
}

function makeTrackCollisionGlb() {
  const half = trackWidth * 0.5;
  return encodeGlb({
    primitives: [makeTrackRibbon(-half, half, 0.0, 0)],
    materials: [[0.48, 0.56, 0.6, 1.0]],
  });
}

function makeTrackRibbon(offsetA, offsetB, yOffset, material, includeSegment = () => true) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const totalDistance = trackLoopLength();
  const distances = [0];
  for (let i = 1; i <= samples; i++) {
    const prev = centerline[(i - 1) % samples];
    const next = centerline[i % samples];
    distances.push(distances[i - 1] + Math.hypot(next.x - prev.x, next.z - prev.z));
  }

  for (let i = 0; i < samples; i++) {
    if (!includeSegment(i)) continue;
    const a = appendRibbonVertex(positions, normals, uvs, centerline[i], offsetA, yOffset, 0, distances[i] / totalDistance);
    const b = appendRibbonVertex(positions, normals, uvs, centerline[i], offsetB, yOffset, 1, distances[i] / totalDistance);
    const c = appendRibbonVertex(positions, normals, uvs, centerline[(i + 1) % samples], offsetA, yOffset, 0, distances[i + 1] / totalDistance);
    const d = appendRibbonVertex(positions, normals, uvs, centerline[(i + 1) % samples], offsetB, yOffset, 1, distances[i + 1] / totalDistance);
    indices.push(a, b, c, b, d, c);
  }

  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
    material,
  };
}

function appendRibbonVertex(positions, normals, uvs, point, offset, yOffset, u, v) {
  const left = { x: -point.tan.z, z: point.tan.x };
  const crown = 0.08 * Math.sin(point.t * 3.0) * (1 - Math.abs(offset) / (trackWidth * 0.5));
  const index = positions.length / 3;
  positions.push(point.x + left.x * offset, point.y + crown + yOffset, point.z + left.z * offset);
  normals.push(0, 1, 0);
  uvs.push(u, v);
  return index;
}

function encodeGlb(model) {
  const buffers = [];
  const views = [];
  const accessors = [];
  const primitiveDefs = [];

  function addBuffer(data, target) {
    const byteOffset = buffers.reduce((sum, b) => sum + b.length, 0);
    buffers.push(data, Buffer.alloc((4 - (data.length % 4)) % 4));
    const viewIndex = views.length;
    const view = { buffer: 0, byteOffset, byteLength: data.length };
    if (target) view.target = target;
    views.push(view);
    return viewIndex;
  }

  function addTypedArray(array, target, type, componentType, count, min, max) {
    const viewIndex = addBuffer(Buffer.from(array.buffer, array.byteOffset, array.byteLength), target);
    const accessor = { bufferView: viewIndex, byteOffset: 0, componentType, count, type };
    if (min) accessor.min = min;
    if (max) accessor.max = max;
    const accessorIndex = accessors.length;
    accessors.push(accessor);
    return accessorIndex;
  }

  for (const primitive of model.primitives) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < primitive.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const v = primitive.positions[i + axis];
        min[axis] = Math.min(min[axis], v);
        max[axis] = Math.max(max[axis], v);
      }
    }
    const positionAccessor = addTypedArray(primitive.positions, 34962, 'VEC3', 5126, primitive.positions.length / 3, min, max);
    const normalAccessor = addTypedArray(primitive.normals, 34962, 'VEC3', 5126, primitive.normals.length / 3);
    const uvAccessor = addTypedArray(primitive.uvs, 34962, 'VEC2', 5126, primitive.uvs.length / 2);
    const indexAccessor = addTypedArray(primitive.indices, 34963, 'SCALAR', 5125, primitive.indices.length);
    primitiveDefs.push({
      attributes: {
        POSITION: positionAccessor,
        NORMAL: normalAccessor,
        TEXCOORD_0: uvAccessor,
      },
      indices: indexAccessor,
      material: primitive.material,
    });
  }

  const images = [];
  for (const image of model.images ?? []) {
    const bufferView = addBuffer(image.data);
    images.push({ bufferView, mimeType: image.mimeType });
  }

  const bin = Buffer.concat(buffers);
  const materials = model.materials.map((material) => {
    const color = Array.isArray(material) ? material : material.color;
    const pbr = {
      baseColorFactor: color,
      roughnessFactor: 0.78,
      metallicFactor: 0,
    };
    if (!Array.isArray(material) && material.texture !== undefined) {
      pbr.baseColorTexture = { index: material.texture };
    }
    return { pbrMetallicRoughness: pbr };
  });
  const json = {
    asset: { version: '2.0', generator: 'MarbleRush demo track generator' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{
      primitives: primitiveDefs,
    }],
    materials,
    buffers: [{ byteLength: bin.length }],
    bufferViews: views,
    accessors,
  };
  if (images.length > 0) {
    json.images = images;
    json.textures = model.textures ?? images.map((_, index) => ({ source: index }));
  }

  const jsonChunk = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const binChunk = pad4(bin, 0);
  const length = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(length, 8);
  return Buffer.concat([header, glbChunk(jsonChunk, 0x4e4f534a), glbChunk(binChunk, 0x004e4942)]);
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

function makeToneWav({ frequency = 220, duration = 1.0, volume = 0.35, wobble = 0 }) {
  const sampleRate = 22050;
  const count = Math.max(1, Math.floor(sampleRate * duration));
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    const t = i / sampleRate;
    const f = frequency * (1 + wobble * Math.sin(t * Math.PI * 2 * 5));
    const envelope = Math.min(1, i / (sampleRate * 0.02)) * Math.min(1, (count - i) / (sampleRate * 0.03));
    const sample = Math.sin(t * Math.PI * 2 * f) * volume * envelope;
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(sample * 32767))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const totalDistance = trackLoopLength();
const start = centerAt(0);
const startTan = tangentAt(0);
const startYaw = yawFromTangent(startTan);
const terrainChunks = makeTerrainChunks();

const map = {
  version: 1,
  name: 'demo_track',
  terrain: {
    tag: 'demo_heightfield_terrain',
    heightmap: 'heightmap.png',
    position: { x: 0, y: terrainY, z: 0 },
    width: terrainWidth,
    height: terrainHeight,
    depth: terrainDepth,
    uvScale: 20,
    tintSet: true,
    tint: { r: 0.43, g: 0.78, b: 0.38, a: 1 },
    friction: 0.92,
  },
  meshes: [{
    name: 'track_collision',
    model: 'track_collision.glb',
    collision: 'trimesh',
    hidden: true,
    friction: 1.05,
  }, {
    name: 'track_mesh',
    model: 'track.glb',
  }],
  spawns: [{
    name: 'player_start',
    position: { x: start.x, y: start.y + kartSpawnYOffset, z: start.z },
    yaw: startYaw,
  }],
};

const track = {
  version: 1,
  name: 'demo_track',
  closedLoop: true,
  terrainChunks,
  meshes: [{
    name: 'track_mesh',
    model: 'track.glb',
    collision: 'none',
  }, {
    name: 'track_collision',
    model: 'track_collision.glb',
    collision: 'trimesh',
    hidden: true,
    friction: 1.05,
  }],
  centerline: makeTrackCenterline(),
  surfaces: makeTrackSurfaces(totalDistance),
  gates: makeTrackGates(totalDistance),
  spawns: [{
    name: 'player_start',
    distance: 0,
    position: { x: start.x, y: start.y + kartSpawnYOffset, z: start.z },
    yaw: startYaw,
  }],
  respawns: makeTrackRespawns(totalDistance),
  triggers: [{
    name: 'lap_line',
    kind: 'lap',
    distance: 0,
    radius: Math.max(11.0, trackWidth * 0.78),
  }],
  racingLines: makeRacingLines(totalDistance),
  metadata: [
    { key: 'authoringTool', value: 'tools/generate_demo_track.mjs' },
    { key: 'units', value: 'meters' },
    { key: 'forward', value: '-Z' },
    { key: 'yaw', value: 'radians around +Y' },
  ],
};

writeFileSync(join(outDir, 'heightmap.png'), makeHeightmap());
for (const chunk of terrainChunks) {
  writeFileSync(
    join(outDir, chunk.heightmap),
    makeHeightmapRegion(chunk.position.x, chunk.position.z, chunk.width, chunk.depth),
  );
}
const trackTexture = makeTrackTexture();
writeFileSync(join(outDir, 'track_texture.png'), trackTexture);
writeFileSync(join(outDir, 'track.glb'), makeTrackVisualGlb(trackTexture));
writeFileSync(join(outDir, 'track_collision.glb'), makeTrackCollisionGlb());
writeFileSync(join(outDir, 'map.json'), `${JSON.stringify(map, null, 2)}\n`);
writeFileSync(join(outDir, 'track.json'), `${JSON.stringify(track, null, 2)}\n`);
writeFileSync(join(audioDir, 'kart_engine.wav'), makeToneWav({ frequency: 115, duration: 1.2, volume: 0.26, wobble: 0.08 }));
writeFileSync(join(audioDir, 'kart_skid.wav'), makeToneWav({ frequency: 520, duration: 0.8, volume: 0.16, wobble: 0.18 }));
writeFileSync(join(audioDir, 'kart_boost.wav'), makeToneWav({ frequency: 760, duration: 0.7, volume: 0.2, wobble: 0.12 }));
writeFileSync(join(audioDir, 'kart_grass.wav'), makeToneWav({ frequency: 175, duration: 0.9, volume: 0.14, wobble: 0.22 }));
writeFileSync(join(audioDir, 'kart_hit.wav'), makeToneWav({ frequency: 90, duration: 0.18, volume: 0.45, wobble: 0.4 }));
console.log(`generated ${outDir}`);
