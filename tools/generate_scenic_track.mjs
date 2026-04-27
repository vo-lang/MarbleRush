import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'assets', 'maps', 'scenic_track');
const modelOutDir = join(root, 'assets', 'models', 'scenic');
mkdirSync(outDir, { recursive: true });
mkdirSync(modelOutDir, { recursive: true });

const terrainWidth = 430;
const terrainDepth = 470;
const terrainY = -3.0;
const terrainHeight = 22.0;
const heightmapSize = 257;
const samples = 320;
const trackWidth = 18.0;
const shoulderWidth = 6.5;
const terrainBlendWidth = 32.0;
const trackClearance = 0.075;
const roadTextureWidth = 640;
const roadTextureHeight = 2048;
const grassTextureSize = 512;
const terrainSplatSize = 512;
const kartSpawnYOffset = 1.28;
const gateCount = 10;

function centerAt(t) {
  return {
    x: 118 * Math.sin(t) + 26 * Math.sin(2 * t - 0.55),
    z: 136 * Math.cos(t) - 30 * Math.cos(3 * t + 0.35),
    y: 3.3 + 1.55 * Math.sin(t - 0.55) + 0.62 * Math.sin(2 * t + 1.1),
    t,
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
  return { ...p, tan: tangentAt(t) };
});

function leftFromTan(tan) {
  return { x: -tan.z, z: tan.x };
}

function yawFromTangent(tan) {
  return Math.atan2(-tan.x, -tan.z);
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function mix(a, b, t) {
  return a * (1 - t) + b * t;
}

function noise2(x, y) {
  let n = (x * 374761393 + y * 668265263) >>> 0;
  n = ((n ^ (n >>> 13)) * 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) & 255) / 255;
}

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

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

function terrainWorldY(x, z) {
  const n = nearestRoad(x, z);
  const halfTrack = trackWidth * 0.5;
  const shoulderT = smoothstep(halfTrack, halfTrack + shoulderWidth, n.distance);
  const roadBed = n.point.y - trackClearance - shoulderT * 0.42;
  const broadHill =
    2.0 +
    3.4 * Math.sin((x + 80) / 86) * Math.cos((z - 20) / 93) +
    1.35 * Math.sin((x - z) / 58) +
    0.8 * Math.cos((x + z) / 44);
  const valley = -1.6 * Math.exp(-(x * x + (z + 20) * (z + 20)) / (2 * 125 * 125));
  const ridgeNorth = 4.4 * smoothstep(95, 210, Math.abs(z + 210));
  const ridgeEast = 2.8 * smoothstep(110, 220, Math.abs(x - 200));
  const scenicTerrain = broadHill + valley + ridgeNorth + ridgeEast;
  const blend = smoothstep(halfTrack + shoulderWidth, halfTrack + shoulderWidth + terrainBlendWidth, n.distance);
  return roadBed * (1 - blend) + scenicTerrain * blend;
}

function trackDistances() {
  const distances = [0];
  for (let i = 1; i <= samples; i++) {
    const a = centerline[(i - 1) % samples];
    const b = centerline[i % samples];
    distances.push(distances[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
  }
  return distances;
}

const distances = trackDistances();
const totalDistance = distances[distances.length - 1];

function trackPointAtDistance(distance) {
  const d = ((distance % totalDistance) + totalDistance) % totalDistance;
  for (let i = 0; i < samples; i++) {
    const start = distances[i];
    const end = distances[i + 1];
    if (d > end && i < samples - 1) continue;
    const a = centerline[i];
    const b = centerline[(i + 1) % samples];
    const span = Math.max(0.0001, end - start);
    const t = clamp((d - start) / span, 0, 1);
    const phase = a.t * (1 - t) + b.t * t;
    const tan = tangentAt(phase);
    const left = leftFromTan(tan);
    return {
      x: mix(a.x, b.x, t),
      y: mix(a.y, b.y, t),
      z: mix(a.z, b.z, t),
      tan,
      left,
      yaw: yawFromTangent(tan),
      phase,
    };
  }
  const p = centerline[0];
  return { ...p, left: leftFromTan(p.tan), yaw: yawFromTangent(p.tan), phase: p.t };
}

function offsetTrackPoint(distance, lateral, yOffset = 0) {
  const p = trackPointAtDistance(distance);
  return {
    x: p.x + p.left.x * lateral,
    y: p.y + yOffset,
    z: p.z + p.left.z * lateral,
    yaw: p.yaw,
    tan: p.tan,
    left: p.left,
    phase: p.phase,
  };
}

function makeHeightmap() {
  const pixels = Buffer.alloc(heightmapSize * heightmapSize);
  for (let row = 0; row < heightmapSize; row++) {
    const z = (row / (heightmapSize - 1) - 0.5) * terrainDepth;
    for (let col = 0; col < heightmapSize; col++) {
      const x = (col / (heightmapSize - 1) - 0.5) * terrainWidth;
      const y = terrainWorldY(x, z);
      pixels[row * heightmapSize + col] = Math.round(clamp((y - terrainY) / terrainHeight, 0, 1) * 255);
    }
  }
  return encodePngGray(heightmapSize, heightmapSize, pixels);
}

function makeTerrainSplatControl() {
  const pixels = Buffer.alloc(terrainSplatSize * terrainSplatSize * 4);
  for (let row = 0; row < terrainSplatSize; row++) {
    const z = (row / (terrainSplatSize - 1) - 0.5) * terrainDepth;
    for (let col = 0; col < terrainSplatSize; col++) {
      const x = (col / (terrainSplatSize - 1) - 0.5) * terrainWidth;
      const nearest = nearestRoad(x, z);
      const y = terrainWorldY(x, z);
      const roadShoulder = 1 - smoothstep(trackWidth * 0.5 + 2.0, trackWidth * 0.5 + shoulderWidth + 18.0, nearest.distance);
      const ridge = smoothstep(6.2, 9.6, y) * (0.55 + textureNoise(col, row, 11) * 0.45);
      const flowerPatch = smoothstep(0.62, 0.93, textureNoise(col + 71, row - 37, 31)) * (1 - roadShoulder * 0.45) * (1 - ridge * 0.65);
      const wornDirt = roadShoulder * (0.22 + textureNoise(col - 19, row + 43, 17) * 0.12);
      const dampLow = smoothstep(0.0, 1.0, 2.4 - y) * (0.12 + textureNoise(col, row, 23) * 0.08);
      let dirt = wornDirt + dampLow;
      let rock = ridge;
      let meadow = flowerPatch * 0.55;
      let grass = Math.max(0.42, 1.0 - dirt * 0.46 - rock * 0.76 - meadow * 0.36);
      const sum = Math.max(0.0001, grass + meadow + dirt + rock);
      putPixel(pixels, (row * terrainSplatSize + col) * 4, [
        (grass / sum) * 255,
        (meadow / sum) * 255,
        (dirt / sum) * 255,
        (rock / sum) * 255,
      ]);
    }
  }
  return encodePngRgba(terrainSplatSize, terrainSplatSize, pixels);
}

function putPixel(pixels, index, color) {
  pixels[index] = Math.round(clamp(color[0], 0, 255));
  pixels[index + 1] = Math.round(clamp(color[1], 0, 255));
  pixels[index + 2] = Math.round(clamp(color[2], 0, 255));
  pixels[index + 3] = color.length > 3 ? Math.round(clamp(color[3], 0, 255)) : 255;
}

function colorMix(a, b, t) {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t), mix(a[3] ?? 255, b[3] ?? 255, t)];
}

function makeGrassTexture() {
  const pixels = Buffer.alloc(grassTextureSize * grassTextureSize * 4);
  for (let y = 0; y < grassTextureSize; y++) {
    for (let x = 0; x < grassTextureSize; x++) {
      const fine = noise2(x, y) - 0.5;
      const patch = noise2(Math.floor(x / 19), Math.floor(y / 19));
      const stripe = 0.5 + 0.5 * Math.sin((x + y * 0.45) / 18);
      let color = colorMix([78, 184, 76, 255], [132, 225, 91, 255], patch * 0.28 + stripe * 0.06);
      color[0] += fine * 6;
      color[1] += fine * 7;
      color[2] += fine * 4;
      if (noise2(x * 7, y * 11) > 0.986) {
        color = colorMix(color, [246, 230, 92, 255], 0.65);
      }
      putPixel(pixels, (y * grassTextureSize + x) * 4, color);
    }
  }
  return encodePngRgba(grassTextureSize, grassTextureSize, pixels);
}

function makeGrassNormalTexture() {
  return makeNormalTexture(grassTextureSize, 'grass', 0.65);
}

function makeGrassMetallicRoughnessTexture() {
  return makeMetallicRoughnessTexture(grassTextureSize, 0.74, 0.0, 0.04);
}

function makeMeadowTexture() {
  return makeTexture(grassTextureSize, (x, y, size) => {
    const n = textureNoise(x, y, 7) - 0.5;
    const clump = textureNoise(x, y, 23);
    let color = colorMix([72, 167, 92, 255], [132, 219, 106, 255], clump * 0.55);
    if (noise2(x * 13 + 5, y * 17 + 11) > 0.975) color = colorMix(color, [250, 220, 92, 255], 0.62);
    if (noise2(x * 19 + 3, y * 7 + 29) > 0.988) color = colorMix(color, [244, 141, 210, 255], 0.54);
    color[0] += n * 12;
    color[1] += n * 16;
    color[2] += n * 9;
    return color;
  });
}

function makeMeadowNormalTexture() {
  return makeNormalTexture(grassTextureSize, 'meadow', 0.7);
}

function makeMeadowMetallicRoughnessTexture() {
  return makeMetallicRoughnessTexture(grassTextureSize, 0.72, 0.0, 0.04);
}

function makeDirtTexture() {
  return makeTexture(grassTextureSize, (x, y) => {
    const fine = textureNoise(x, y, 3) - 0.5;
    const coarse = textureNoise(x, y, 17);
    let color = colorMix([96, 67, 42, 255], [159, 118, 68, 255], coarse * 0.68);
    if (scratchMask(x, y, grassTextureSize, 0.018) > 0) color = colorMix(color, [207, 178, 119, 255], 0.24);
    color[0] += fine * 16;
    color[1] += fine * 12;
    color[2] += fine * 8;
    return color;
  });
}

function makeDirtNormalTexture() {
  return makeNormalTexture(grassTextureSize, 'dirt', 2.2);
}

function makeDirtMetallicRoughnessTexture() {
  return makeMetallicRoughnessTexture(grassTextureSize, 0.78, 0.0, 0.12);
}

function makeRockTexture() {
  return makeTexture(grassTextureSize, (x, y) => {
    const u = x / Math.max(1, grassTextureSize - 1);
    const vein = Math.abs(fract((u * 2.1 + y / grassTextureSize * 0.55) * 9.0) - 0.5);
    const broad = textureNoise(x, y, 29);
    let color = colorMix([104, 118, 112, 255], [168, 179, 164, 255], broad * 0.58);
    if (vein < 0.05) color = colorMix(color, [211, 217, 194, 255], 0.34);
    if (scratchMask(x, y, grassTextureSize, 0.018) > 0) color = colorMix(color, [70, 83, 82, 255], 0.24);
    return color;
  });
}

function makeRockNormalTexture() {
  return makeNormalTexture(grassTextureSize, 'rock', 2.8);
}

function makeRockMetallicRoughnessTexture() {
  return makeMetallicRoughnessTexture(grassTextureSize, 0.64, 0.0, 0.14);
}

function makeRoadTexture() {
  const pixels = Buffer.alloc(roadTextureWidth * roadTextureHeight * 4);
  for (let y = 0; y < roadTextureHeight; y++) {
    const v = (y + 0.5) / roadTextureHeight;
    const dash = Math.floor(v * 96) % 2 === 0;
    for (let x = 0; x < roadTextureWidth; x++) {
      const u = (x + 0.5) / roadTextureWidth;
      const fine = noise2(x, y) - 0.5;
      const coarse = noise2(Math.floor(x / 7), Math.floor(y / 7)) - 0.5;
      let color = [68 + fine * 5 + coarse * 4, 78 + fine * 5 + coarse * 4, 82 + fine * 4 + coarse * 3, 255];
      const laneWear = 0.5 + 0.5 * Math.sin(v * Math.PI * 36 + Math.sin(u * Math.PI * 9) * 0.6);
      const tireLeft = Math.abs(u - (0.33 + Math.sin(v * Math.PI * 10) * 0.018));
      const tireRight = Math.abs(u - (0.67 + Math.cos(v * Math.PI * 11) * 0.018));
      if (tireLeft < 0.033 || tireRight < 0.033) {
        color = colorMix(color, [46, 54, 58, 255], 0.14 + laneWear * 0.06);
      }
      const edge = Math.min(u, 1 - u);
      if (edge < 0.035) {
        color = colorMix(color, [238, 243, 228, 255], 0.95);
      }
      if (Math.abs(u - 0.5) < 0.012 && dash) {
        color = colorMix(color, [255, 220, 64, 255], 0.96);
      }
      putPixel(pixels, (y * roadTextureWidth + x) * 4, color);
    }
  }
  return encodePngRgba(roadTextureWidth, roadTextureHeight, pixels);
}

function makeRoadNormalTexture() {
  const pixels = Buffer.alloc(roadTextureWidth * roadTextureHeight * 4);
  for (let y = 0; y < roadTextureHeight; y++) {
    for (let x = 0; x < roadTextureWidth; x++) {
      const n = noise2(x, y) - 0.5;
      const m = noise2(Math.floor(x / 5), Math.floor(y / 5)) - 0.5;
      const nx = 128 + n * 4 + m * 3;
      const ny = 128 + (noise2(x + 37, y + 19) - 0.5) * 4;
      const nz = 248;
      putPixel(pixels, (y * roadTextureWidth + x) * 4, [nx, ny, nz, 255]);
    }
  }
  return encodePngRgba(roadTextureWidth, roadTextureHeight, pixels);
}

function makeTexture(size, sample) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      putPixel(pixels, (y * size + x) * 4, sample(x, y, size));
    }
  }
  return encodePngRgba(size, size, pixels);
}

function fract(v) {
  return v - Math.floor(v);
}

function textureNoise(x, y, cell = 1) {
  return noise2(Math.floor(x / cell), Math.floor(y / cell));
}

function scratchMask(x, y, size, density) {
  const grain = noise2(x * 17 + 13, y * 31 + 7);
  const line = Math.abs(fract((x * 0.85 + y * 0.17) / size * 28) - 0.5);
  return grain > 1 - density && line < 0.045 ? 1 : 0;
}

function edgeWear(x, y, size, width) {
  const d = Math.min(x, y, size - 1 - x, size - 1 - y);
  return 1 - smoothstep(0, width, d);
}

function materialHeight(kind, x, y, size) {
  const u = x / Math.max(1, size - 1);
  const v = y / Math.max(1, size - 1);
  if (kind === 'paint') {
    return textureNoise(x, y, 6) * 0.32 + textureNoise(x, y, 23) * 0.18 + scratchMask(x, y, size, 0.02) * 0.7;
  }
  if (kind === 'rubber') {
    return Math.sin(v * Math.PI * 34) * 0.22 + textureNoise(x, y, 5) * 0.24 + textureNoise(x, y, 19) * 0.16;
  }
  if (kind === 'metal') {
    return Math.sin(u * Math.PI * 66) * 0.08 + textureNoise(x, y, 4) * 0.18 + scratchMask(x, y, size, 0.028) * 0.55;
  }
  if (kind === 'asphalt') {
    return textureNoise(x, y, 3) * 0.28 + textureNoise(x, y, 11) * 0.2 + scratchMask(x, y, size, 0.02) * 0.35;
  }
  if (kind === 'leaf') {
    return Math.sin((u + v * 0.7) * Math.PI * 18) * 0.2 + textureNoise(x, y, 7) * 0.28;
  }
  if (kind === 'grass') {
    const blade = Math.sin((u * 1.7 + v * 0.35) * Math.PI * 42) * 0.13;
    const clump = textureNoise(x, y, 11) * 0.28 + textureNoise(x, y, 29) * 0.18;
    return blade + clump;
  }
  if (kind === 'meadow') {
    const blade = Math.sin((u * 1.2 + v * 0.5) * Math.PI * 36) * 0.11;
    const tuft = textureNoise(x, y, 17) * 0.22 + textureNoise(x, y, 41) * 0.16;
    return blade + tuft;
  }
  if (kind === 'dirt') {
    return textureNoise(x, y, 4) * 0.22 + textureNoise(x, y, 13) * 0.24 + scratchMask(x, y, size, 0.02) * 0.3;
  }
  if (kind === 'rock') {
    const strata = Math.sin((u * 1.9 + v * 0.45) * Math.PI * 18) * 0.22;
    return strata + textureNoise(x, y, 5) * 0.28 + textureNoise(x, y, 23) * 0.2;
  }
  return textureNoise(x, y, 8) * 0.18;
}

function makeNormalTexture(size, kind, strength) {
  return makeTexture(size, (x, y) => {
    const xl = (x - 1 + size) % size;
    const xr = (x + 1) % size;
    const yu = (y - 1 + size) % size;
    const yd = (y + 1) % size;
    const dx = (materialHeight(kind, xr, y, size) - materialHeight(kind, xl, y, size)) * strength;
    const dy = (materialHeight(kind, x, yd, size) - materialHeight(kind, x, yu, size)) * strength;
    const len = Math.hypot(dx, dy, 1) || 1;
    return [128 - (dx / len) * 127, 128 - (dy / len) * 127, 128 + (1 / len) * 127, 255];
  });
}

function makeMetallicRoughnessTexture(size, roughness, metallic, variation = 0.08) {
  return makeTexture(size, (x, y) => {
    const n = textureNoise(x, y, 9) - 0.5;
    const r = clamp((roughness + n * variation) * 255, 0, 255);
    const m = clamp(metallic * 255, 0, 255);
    return [0, r, m, 255];
  });
}

function makePaintAlbedo(size, base, hi, low, accent = null) {
  return makeTexture(size, (x, y) => {
    const u = x / Math.max(1, size - 1);
    const v = y / Math.max(1, size - 1);
    const n = textureNoise(x, y, 5) - 0.5;
    const broad = textureNoise(x, y, 31);
    let color = colorMix(low, hi, 0.57 + 0.035 * Math.sin((u * 1.1 + v * 0.35) * Math.PI * 2) + broad * 0.035);
    color = colorMix(color, base, 0.84);
    const wear = edgeWear(x, y, size, size * 0.11);
    color = colorMix(color, [255, 250, 212, 255], wear * 0.045);
    if (scratchMask(x, y, size, 0.008) > 0) {
      color = colorMix(color, accent ?? [82, 58, 34, 255], 0.08);
    }
    color[0] += n * 3;
    color[1] += n * 3;
    color[2] += n * 2;
    return color;
  });
}

function makeRubberAlbedo(size) {
  return makeTexture(size, (x, y) => {
    const v = y / Math.max(1, size - 1);
    const groove = 0.5 + 0.5 * Math.sin(v * Math.PI * 44);
    const n = textureNoise(x, y, 5) - 0.5;
    const chalk = scratchMask(x, y, size, 0.018);
    let color = [14 + n * 18, 18 + n * 18, 20 + n * 16, 255];
    color = colorMix(color, [42, 45, 44, 255], groove * 0.22);
    if (chalk > 0) {
      color = colorMix(color, [130, 130, 118, 255], 0.32);
    }
    return color;
  });
}

function makeTireRubberAlbedo(size, base, hi, low, chalkTint) {
  return makeTexture(size, (x, y) => {
    const u = x / Math.max(1, size - 1);
    const v = y / Math.max(1, size - 1);
    const sidewallRing = 0.5 + 0.5 * Math.sin(v * Math.PI * 18);
    const moldedBands = Math.abs(fract(v * 7.0) - 0.5) < 0.055 ? 1 : 0;
    const fine = textureNoise(x, y, 4) - 0.5;
    const broad = textureNoise(x, y, 27);
    const dirt = textureNoise(x + 37, y - 19, 13);
    let color = colorMix(low, hi, 0.28 + broad * 0.14 + sidewallRing * 0.045);
    color = colorMix(color, base, 0.55);
    color = colorMix(color, [38, 36, 31, 255], dirt * 0.26);
    if (moldedBands > 0) {
      color = colorMix(color, chalkTint, 0.08);
    }
    const wornEdge = Math.max(edgeWear(x, y, size, size * 0.08), scratchMask(x, y, size, 0.022));
    if (wornEdge > 0) {
      color = colorMix(color, chalkTint, wornEdge * 0.12);
    }
    color[0] += fine * 7;
    color[1] += fine * 7;
    color[2] += fine * 6;
    return color;
  });
}

function makeMetalAlbedo(size, dark = false) {
  return makeTexture(size, (x, y) => {
    const u = x / Math.max(1, size - 1);
    const n = textureNoise(x, y, 4) - 0.5;
    const scratch = scratchMask(x, y, size, 0.035);
    const base = dark ? [48, 58, 64, 255] : [154, 170, 174, 255];
    const hi = dark ? [82, 94, 102, 255] : [214, 226, 224, 255];
    let color = colorMix(base, hi, 0.22 + 0.18 * Math.sin(u * Math.PI * 5));
    color[0] += n * 16;
    color[1] += n * 16;
    color[2] += n * 16;
    if (scratch > 0) {
      color = colorMix(color, hi, 0.42);
    }
    return color;
  });
}

function makeAsphaltAlbedo(size) {
  return makeTexture(size, (x, y) => {
    const u = x / Math.max(1, size - 1);
    const fine = textureNoise(x, y, 3) - 0.5;
    const coarse = textureNoise(x, y, 13) - 0.5;
    const laneWear = Math.sin(u * Math.PI * 5) * 0.08;
    let color = [50 + fine * 7 + coarse * 8 + laneWear * 18, 59 + fine * 7 + coarse * 7 + laneWear * 15, 63 + fine * 6 + coarse * 6 + laneWear * 13, 255];
    if (scratchMask(x, y, size, 0.018) > 0) {
      color = colorMix(color, [112, 126, 124, 255], 0.12);
    }
    return color;
  });
}

function makeAsphaltNormalTexture(size) {
  return makeNormalTexture(size, 'asphalt', 0.9);
}

function makeLeafAlbedo(size) {
  return makeTexture(size, (x, y) => {
    const u = x / Math.max(1, size - 1);
    const v = y / Math.max(1, size - 1);
    const vein = Math.abs(fract((u + v * 0.7) * 9) - 0.5);
    const n = textureNoise(x, y, 8);
    let color = colorMix([38, 122, 55, 255], [97, 205, 89, 255], n * 0.65 + (vein < 0.045 ? 0.22 : 0));
    if (noise2(x * 11, y * 13) > 0.992) {
      color = colorMix(color, [248, 225, 84, 255], 0.55);
    }
    return color;
  });
}

function makeSceneryImages() {
  const size = 256;
  return [
    { mimeType: 'image/png', data: makePaintAlbedo(size, [255, 218, 67, 255], [255, 241, 142, 255], [216, 156, 32, 255], [117, 78, 22, 255]) },
    { mimeType: 'image/png', data: makeNormalTexture(size, 'paint', 0.62) },
    { mimeType: 'image/png', data: makeMetallicRoughnessTexture(size, 0.28, 0.0, 0.025) },
    { mimeType: 'image/png', data: makeRubberAlbedo(size) },
    { mimeType: 'image/png', data: makeNormalTexture(size, 'rubber', 3.2) },
    { mimeType: 'image/png', data: makeMetallicRoughnessTexture(size, 0.9, 0.0, 0.05) },
    { mimeType: 'image/png', data: makeMetalAlbedo(size, false) },
    { mimeType: 'image/png', data: makeNormalTexture(size, 'metal', 0.75) },
    { mimeType: 'image/png', data: makeMetallicRoughnessTexture(size, 0.26, 0.85, 0.05) },
    { mimeType: 'image/png', data: makeMetalAlbedo(size, true) },
    { mimeType: 'image/png', data: makeMetallicRoughnessTexture(size, 0.42, 0.9, 0.08) },
    { mimeType: 'image/png', data: makeLeafAlbedo(size) },
    { mimeType: 'image/png', data: makeNormalTexture(size, 'leaf', 1.15) },
    { mimeType: 'image/png', data: makeMetallicRoughnessTexture(size, 0.58, 0.0, 0.05) },
    { mimeType: 'image/png', data: makePaintAlbedo(size, [255, 241, 181, 255], [255, 252, 220, 255], [197, 177, 116, 255], [112, 84, 42, 255]) },
    { mimeType: 'image/png', data: makeNormalTexture(size, 'paint', 0.58) },
    { mimeType: 'image/png', data: makeMetallicRoughnessTexture(size, 0.3, 0.0, 0.025) },
    { mimeType: 'image/png', data: makePaintAlbedo(size, [23, 27, 31, 255], [58, 62, 65, 255], [5, 6, 8, 255], [255, 225, 119, 255]) },
    { mimeType: 'image/png', data: makeNormalTexture(size, 'paint', 0.55) },
    { mimeType: 'image/png', data: makeMetallicRoughnessTexture(size, 0.42, 0.0, 0.035) },
    { mimeType: 'image/png', data: makeAsphaltAlbedo(size) },
    { mimeType: 'image/png', data: makeAsphaltNormalTexture(size) },
    { mimeType: 'image/png', data: makeMetallicRoughnessTexture(size, 0.62, 0.0, 0.04) },
    { mimeType: 'image/png', data: makePaintAlbedo(size, [34, 116, 255, 255], [104, 178, 255, 255], [16, 62, 171, 255], [255, 235, 130, 255]) },
    { mimeType: 'image/png', data: makeNormalTexture(size, 'paint', 0.6) },
    { mimeType: 'image/png', data: makeMetallicRoughnessTexture(size, 0.27, 0.0, 0.025) },
    { mimeType: 'image/png', data: makePaintAlbedo(size, [232, 42, 58, 255], [255, 111, 112, 255], [145, 15, 34, 255], [255, 230, 136, 255]) },
    { mimeType: 'image/png', data: makeNormalTexture(size, 'paint', 0.6) },
    { mimeType: 'image/png', data: makeMetallicRoughnessTexture(size, 0.3, 0.0, 0.025) },
    { mimeType: 'image/png', data: makeTireRubberAlbedo(size, [150, 50, 38, 255], [194, 76, 54, 255], [70, 24, 20, 255], [214, 152, 118, 255]) },
    { mimeType: 'image/png', data: makeTireRubberAlbedo(size, [184, 174, 147, 255], [229, 219, 190, 255], [104, 96, 79, 255], [238, 232, 210, 255]) },
    { mimeType: 'image/png', data: makeTireRubberAlbedo(size, [86, 82, 75, 255], [132, 126, 112, 255], [35, 34, 32, 255], [184, 176, 156, 255]) },
    { mimeType: 'image/png', data: makeTireRubberAlbedo(size, [30, 29, 27, 255], [62, 58, 52, 255], [7, 7, 7, 255], [142, 133, 116, 255]) },
  ];
}

function encodePngGray(width, height, pixels) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let row = 0; row < height; row++) {
    raw[row * (width + 1)] = 0;
    pixels.copy(raw, row * (width + 1) + 1, row * width, (row + 1) * width);
  }
  return encodePng(width, height, 0, raw);
}

function encodePngRgba(width, height, pixels) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row++) {
    raw[row * (width * 4 + 1)] = 0;
    pixels.copy(raw, row * (width * 4 + 1) + 1, row * width * 4, (row + 1) * width * 4);
  }
  return encodePng(width, height, 6, raw);
}

function encodePng(width, height, colorType, raw) {
  const chunks = [
    chunk('IHDR', Buffer.concat([u32(width), u32(height), Buffer.from([8, colorType, 0, 0, 0])])),
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

function makeTrackCenterline() {
  return [...centerline, centerline[0]].map((p, index) => ({
    name: `scenic_cp_${String(index).padStart(3, '0')}`,
    position: { x: round(p.x), y: round(p.y), z: round(p.z) },
    width: trackWidth,
    bank: round(0.075 * Math.sin(p.t * 2.0 - 0.25)),
  }));
}

function makeTrackSurfaces() {
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
    kind: 'boost',
    start: round(totalDistance * 0.17),
    end: round(totalDistance * 0.225),
    left: -3.3,
    right: 3.3,
    priority: 8,
    friction: 1.08,
    boost: 1.45,
  }, {
    name: 'left_grass',
    kind: 'offroad',
    start: 0,
    end: 0,
    left: -half - shoulderWidth - terrainBlendWidth,
    right: -half,
    priority: 2,
    friction: 0.64,
  }, {
    name: 'right_grass',
    kind: 'offroad',
    start: 0,
    end: 0,
    left: half,
    right: half + shoulderWidth + terrainBlendWidth,
    priority: 2,
    friction: 0.64,
  }];
}

function makeTrackGates() {
  return Array.from({ length: gateCount }, (_, i) => ({
    name: i === gateCount - 1 ? 'Finish' : `Gate ${i + 1}`,
    distance: round((totalDistance * (i + 1)) / gateCount),
    width: trackWidth + 5,
    radius: 15,
  }));
}

function makeTrackRespawns() {
  return Array.from({ length: gateCount }, (_, i) => {
    const p = offsetTrackPoint((totalDistance * i) / gateCount, 0, kartSpawnYOffset);
    return {
      name: i === 0 ? 'start_respawn' : `respawn_${i}`,
      distance: round((totalDistance * i) / gateCount),
      position: { x: round(p.x), y: round(p.y), z: round(p.z) },
      yaw: round(p.yaw),
    };
  });
}

function makeRacingLines() {
  const count = 56;
  const points = Array.from({ length: count + 1 }, (_, i) => {
    const distance = (totalDistance * i) / count;
    const phase = (i / count) * Math.PI * 2;
    return {
      distance: round(distance),
      lateral: round(Math.sin(phase * 2.0 + 0.4) * trackWidth * 0.18),
      targetSpeed: round(27 + 8 * (0.5 + 0.5 * Math.cos(phase * 3.0 - 0.4))),
    };
  });
  return [{ name: 'scenic_line', points }];
}

function makeTrackJson() {
  const start = offsetTrackPoint(4, 0, kartSpawnYOffset);
  return {
    version: 1,
    name: 'scenic_track',
    closedLoop: true,
    terrain: {
      tag: 'scenic_terrain',
      heightmap: 'heightmap.png',
      position: { x: 0, y: terrainY, z: 0 },
      width: terrainWidth,
      height: terrainHeight,
      depth: terrainDepth,
      splat: makeTerrainSplatJson(),
      tintSet: true,
      tint: { r: 0.86, g: 0.98, b: 0.82, a: 1 },
      friction: 0.92,
    },
    meshes: [
      { name: 'scenic_road', model: 'road.glb', collision: 'none' },
      { name: 'scenic_road_collision', model: 'road_collision.glb', collision: 'trimesh', hidden: true, friction: 1.05 },
      { name: 'scenic_props', model: 'scenic_props.glb', collision: 'none' },
    ],
    centerline: makeTrackCenterline(),
    surfaces: makeTrackSurfaces(),
    gates: makeTrackGates(),
    spawns: [{
      name: 'player_start',
      distance: 4,
      position: { x: round(start.x), y: round(start.y), z: round(start.z) },
      yaw: round(start.yaw),
    }],
    respawns: makeTrackRespawns(),
    triggers: [{ name: 'lap_line', kind: 'lap', distance: 0, radius: 15 }],
    racingLines: makeRacingLines(),
    metadata: [
      { key: 'authoringTool', value: 'tools/generate_scenic_track.mjs' },
      { key: 'visualGoal', value: 'scenic kart racing reference' },
      { key: 'units', value: 'meters' },
      { key: 'forward', value: '-Z' },
      { key: 'yaw', value: 'radians around +Y' },
    ],
  };
}

function makeMapJson() {
  const start = offsetTrackPoint(4, 0, kartSpawnYOffset);
  return {
    version: 1,
    name: 'scenic_track',
    terrain: {
      tag: 'scenic_terrain',
      heightmap: 'heightmap.png',
      position: { x: 0, y: terrainY, z: 0 },
      width: terrainWidth,
      height: terrainHeight,
      depth: terrainDepth,
      splat: makeTerrainSplatJson(),
      tintSet: true,
      tint: { r: 0.86, g: 0.98, b: 0.82, a: 1 },
      friction: 0.92,
    },
    meshes: [
      { name: 'scenic_road_collision', model: 'road_collision.glb', collision: 'trimesh', hidden: true, friction: 1.05 },
      { name: 'scenic_road', model: 'road.glb' },
      { name: 'scenic_props', model: 'scenic_props.glb' },
    ],
    spawns: [{ name: 'player_start', position: { x: round(start.x), y: round(start.y), z: round(start.z) }, yaw: round(start.yaw) }],
  };
}

function makeTerrainSplatJson() {
  return {
    control: 'terrain_splat.png',
    layers: [
      { texture: 'grass_texture.png', normal: 'grass_normal.png', metallicRoughness: 'grass_mr.png', uvScale: 18, normalScale: 0.36 },
      { texture: 'meadow_texture.png', normal: 'meadow_normal.png', metallicRoughness: 'meadow_mr.png', uvScale: 15, normalScale: 0.38 },
      { texture: 'dirt_texture.png', normal: 'dirt_normal.png', metallicRoughness: 'dirt_mr.png', uvScale: 11, normalScale: 0.52 },
      { texture: 'rock_texture.png', normal: 'rock_normal.png', metallicRoughness: 'rock_mr.png', uvScale: 8, normalScale: 0.68 },
    ],
  };
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}

function makeTrackRibbon(offsetA, offsetB, yOffset, material, includeSegment = () => true, uvScale = 1) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  for (let i = 0; i < samples; i++) {
    if (!includeSegment(i, distances[i], distances[i + 1])) continue;
    const a = appendRibbonVertex(positions, normals, uvs, centerline[i], offsetA, yOffset, 0, distances[i] / totalDistance * uvScale);
    const b = appendRibbonVertex(positions, normals, uvs, centerline[i], offsetB, yOffset, 1, distances[i] / totalDistance * uvScale);
    const c = appendRibbonVertex(positions, normals, uvs, centerline[(i + 1) % samples], offsetA, yOffset, 0, distances[i + 1] / totalDistance * uvScale);
    const d = appendRibbonVertex(positions, normals, uvs, centerline[(i + 1) % samples], offsetB, yOffset, 1, distances[i + 1] / totalDistance * uvScale);
    indices.push(a, b, c, b, d, c);
  }
  return primitiveFromArrays(positions, normals, uvs, indices, material);
}

function appendRibbonVertex(positions, normals, uvs, point, offset, yOffset, u, v) {
  const left = leftFromTan(point.tan);
  const crown = 0.12 * (1 - Math.abs(offset) / (trackWidth * 0.5));
  const bank = 0.075 * Math.sin(point.t * 2.0 - 0.25) * offset;
  const index = positions.length / 3;
  positions.push(point.x + left.x * offset, point.y + crown + bank + yOffset, point.z + left.z * offset);
  normals.push(0, 1, 0);
  uvs.push(u, v);
  return index;
}

function makeRoadGlb(roadTexture, roadNormal) {
  const half = trackWidth * 0.5;
  const redCurb = (i) => Math.floor(i / 2) % 2 === 0;
  const whiteCurb = (i) => !redCurb(i);
  const primitives = [
    makeTrackRibbon(-half, half, 0.055, 0, () => true, 1),
    makeTrackRibbon(-half - 1.25, -half, 0.065, 1, redCurb, 12),
    makeTrackRibbon(half, half + 1.25, 0.065, 1, redCurb, 12),
    makeTrackRibbon(-half - 1.25, -half, 0.066, 2, whiteCurb, 12),
    makeTrackRibbon(half, half + 1.25, 0.066, 2, whiteCurb, 12),
    makeTrackRibbon(-half - shoulderWidth, -half - 1.25, 0.035, 3, () => true, 4),
    makeTrackRibbon(half + 1.25, half + shoulderWidth, 0.035, 3, () => true, 4),
    makeBoostPadRibbon(totalDistance * 0.17, totalDistance * 0.225),
  ];
  return encodeGlb({
    primitives,
    materials: [
      { color: [1, 1, 1, 1], texture: 0, normalTexture: 1, roughness: 0.54 },
      { color: [0.96, 0.045, 0.035, 1], roughness: 0.34 },
      { color: [1.0, 0.98, 0.88, 1], roughness: 0.32 },
      { color: [0.62, 0.82, 0.34, 1], roughness: 0.5 },
      { color: [0.08, 0.82, 1.0, 1], emissive: [0.0, 0.42, 0.75], roughness: 0.18 },
    ],
    images: [
      { mimeType: 'image/png', data: roadTexture },
      { mimeType: 'image/png', data: roadNormal },
    ],
    textures: [{ source: 0 }, { source: 1 }],
  });
}

function makeBoostPadRibbon(startDistance, endDistance) {
  return makeTrackRibbon(-3.2, 3.2, 0.12, 4, (_, d0, d1) => {
    const mid = (d0 + d1) * 0.5;
    return mid >= startDistance && mid <= endDistance;
  }, 5);
}

function makeCollisionGlb() {
  const half = trackWidth * 0.5 + 1.6;
  return encodeGlb({
    primitives: [makeTrackRibbon(-half, half, 0.02, 0)],
    materials: [{ color: [0.45, 0.55, 0.58, 1], roughness: 0.9 }],
  });
}

function primitiveFromArrays(positions, normals, uvs, indices, material) {
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
    material,
  };
}

function makeBuilder() {
  return new Map();
}

function builderArrays(builder, material) {
  if (!builder.has(material)) {
    builder.set(material, { positions: [], normals: [], uvs: [], indices: [] });
  }
  return builder.get(material);
}

function addVertex(arrays, position, normal, uv = [0, 0]) {
  const index = arrays.positions.length / 3;
  arrays.positions.push(position[0], position[1], position[2]);
  arrays.normals.push(normal[0], normal[1], normal[2]);
  arrays.uvs.push(uv[0], uv[1]);
  return index;
}

function rotateYaw(x, z, yaw) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [x * c - z * s, x * s + z * c];
}

function addBox(builder, center, size, yaw, material) {
  const arrays = builderArrays(builder, material);
  const hx = size.x * 0.5;
  const hy = size.y * 0.5;
  const hz = size.z * 0.5;
  const faces = [
    { n: [0, 1, 0], pts: [[-hx, hy, -hz], [hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz]] },
    { n: [0, -1, 0], pts: [[-hx, -hy, hz], [hx, -hy, hz], [-hx, -hy, -hz], [hx, -hy, -hz]] },
    { n: [0, 0, 1], pts: [[-hx, -hy, hz], [hx, -hy, hz], [-hx, hy, hz], [hx, hy, hz]] },
    { n: [0, 0, -1], pts: [[hx, -hy, -hz], [-hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz]] },
    { n: [1, 0, 0], pts: [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, hz], [hx, hy, -hz]] },
    { n: [-1, 0, 0], pts: [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, -hz], [-hx, hy, hz]] },
  ];
  for (const face of faces) {
    const base = arrays.positions.length / 3;
    for (const p of face.pts) {
      const [rx, rz] = rotateYaw(p[0], p[2], yaw);
      const [nx, nz] = rotateYaw(face.n[0], face.n[2], yaw);
      addVertex(arrays, [center.x + rx, center.y + p[1], center.z + rz], [nx, face.n[1], nz], [p[0] > 0 ? 1 : 0, p[2] > 0 ? 1 : 0]);
    }
    arrays.indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
}

function axisFromYaw(yaw) {
  return {
    right: { x: Math.cos(yaw), y: 0, z: Math.sin(yaw) },
    up: { x: 0, y: 1, z: 0 },
    normal: { x: -Math.sin(yaw), y: 0, z: Math.cos(yaw) },
  };
}

function vecScale(v, s) {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function vecAdd(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function vecNormalize(v) {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function localPoint(origin, yaw, x, y, z) {
  const [rx, rz] = rotateYaw(x, z, yaw);
  return { x: origin.x + rx, y: origin.y + y, z: origin.z + rz };
}

function addLocalBox(builder, origin, yaw, offset, size, localYaw, material) {
  addBox(builder, localPoint(origin, yaw, offset.x, offset.y, offset.z), size, yaw + localYaw, material);
}

function addCuboid(builder, center, axisX, axisY, axisZ, size, material) {
  const arrays = builderArrays(builder, material);
  const hx = size.x * 0.5;
  const hy = size.y * 0.5;
  const hz = size.z * 0.5;
  const faces = [
    { n: axisY, pts: [[-1, 1, -1], [1, 1, -1], [-1, 1, 1], [1, 1, 1]] },
    { n: vecScale(axisY, -1), pts: [[-1, -1, 1], [1, -1, 1], [-1, -1, -1], [1, -1, -1]] },
    { n: axisZ, pts: [[-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1]] },
    { n: vecScale(axisZ, -1), pts: [[1, -1, -1], [-1, -1, -1], [1, 1, -1], [-1, 1, -1]] },
    { n: axisX, pts: [[1, -1, 1], [1, -1, -1], [1, 1, 1], [1, 1, -1]] },
    { n: vecScale(axisX, -1), pts: [[-1, -1, -1], [-1, -1, 1], [-1, 1, -1], [-1, 1, 1]] },
  ];
  for (const face of faces) {
    const base = arrays.positions.length / 3;
    for (const p of face.pts) {
      const pos = vecAdd(
        vecAdd(vecAdd(center, vecScale(axisX, p[0] * hx)), vecScale(axisY, p[1] * hy)),
        vecScale(axisZ, p[2] * hz),
      );
      addVertex(arrays, [pos.x, pos.y, pos.z], [face.n.x, face.n.y, face.n.z], [p[0] > 0 ? 1 : 0, p[1] > 0 ? 1 : 0]);
    }
    arrays.indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
}

function signedPow(v, exponent) {
  return Math.sign(v) * Math.pow(Math.abs(v), exponent);
}

function addRoundedCuboid(builder, center, axisX, axisY, axisZ, size, material, exponent = 0.26, segments = 28, rings = 14) {
  const arrays = builderArrays(builder, material);
  const hx = Math.max(size.x * 0.5, 0.001);
  const hy = Math.max(size.y * 0.5, 0.001);
  const hz = Math.max(size.z * 0.5, 0.001);
  const rowStart = [];
  for (let y = 0; y <= rings; y++) {
    const v = -Math.PI * 0.5 + (y / rings) * Math.PI;
    const cv = Math.cos(v);
    const sv = Math.sin(v);
    rowStart.push(arrays.positions.length / 3);
    for (let x = 0; x <= segments; x++) {
      const u = -Math.PI + (x / segments) * Math.PI * 2;
      const cu = Math.cos(u);
      const su = Math.sin(u);
      const lx = hx * signedPow(cv, exponent) * signedPow(cu, exponent);
      const ly = hy * signedPow(sv, exponent);
      const lz = hz * signedPow(cv, exponent) * signedPow(su, exponent);
      const world = vecAdd(center, vecAdd(vecAdd(vecScale(axisX, lx), vecScale(axisY, ly)), vecScale(axisZ, lz)));
      const normal = vecNormalize(vecAdd(vecAdd(vecScale(axisX, lx / hx), vecScale(axisY, ly / hy)), vecScale(axisZ, lz / hz)));
      addVertex(arrays, [world.x, world.y, world.z], [normal.x, normal.y, normal.z], [x / segments, y / rings]);
    }
  }
  for (let y = 0; y < rings; y++) {
    for (let x = 0; x < segments; x++) {
      const a = rowStart[y] + x;
      const b = rowStart[y] + x + 1;
      const c = rowStart[y + 1] + x;
      const d = rowStart[y + 1] + x + 1;
      arrays.indices.push(a, c, b, b, c, d);
    }
  }
}

function addRoundedLocalBox(builder, origin, yaw, offset, size, localYaw, material, exponent = 0.26, segments = 28, rings = 14) {
  const axes = axisFromYaw(yaw + localYaw);
  addRoundedCuboid(builder, localPoint(origin, yaw, offset.x, offset.y, offset.z), axes.right, axes.up, axes.normal, size, material, exponent, segments, rings);
}

function addRoundedPanelBar(builder, origin, yaw, offset, length, thickness, depth, angle, faceSign, material) {
  const axes = axisFromYaw(yaw);
  const center = localPoint(origin, yaw, offset.x, offset.y, offset.z);
  const axisX = vecNormalize(vecAdd(vecScale(axes.right, Math.cos(angle)), vecScale(axes.up, Math.sin(angle))));
  const axisY = vecNormalize(vecAdd(vecScale(axes.right, -Math.sin(angle)), vecScale(axes.up, Math.cos(angle))));
  const axisZ = vecScale(axes.normal, faceSign);
  addRoundedCuboid(builder, center, axisX, axisY, axisZ, { x: length, y: thickness, z: depth }, material, 0.24, 18, 8);
}

function addPanelBar(builder, origin, yaw, offset, length, thickness, depth, angle, faceSign, material) {
  const axes = axisFromYaw(yaw);
  const center = localPoint(origin, yaw, offset.x, offset.y, offset.z);
  const axisX = vecNormalize(vecAdd(vecScale(axes.right, Math.cos(angle)), vecScale(axes.up, Math.sin(angle))));
  const axisY = vecNormalize(vecAdd(vecScale(axes.right, -Math.sin(angle)), vecScale(axes.up, Math.cos(angle))));
  const axisZ = vecScale(axes.normal, faceSign);
  addCuboid(builder, center, axisX, axisY, axisZ, { x: length, y: thickness, z: depth }, material);
}

function addBeamBetween(builder, a, b, thickness, material) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len <= 0.001) return;
  const yaw = Math.atan2(dx, dz);
  addBox(builder, { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5, z: (a.z + b.z) * 0.5 }, { x: thickness, y: thickness, z: len }, yaw, material);
}

function addCylinder(builder, center, radius, height, sides, material) {
  const arrays = builderArrays(builder, material);
  const topCenter = addVertex(arrays, [center.x, center.y + height * 0.5, center.z], [0, 1, 0], [0.5, 0.5]);
  const bottomCenter = addVertex(arrays, [center.x, center.y - height * 0.5, center.z], [0, -1, 0], [0.5, 0.5]);
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const b = ((i + 1) / sides) * Math.PI * 2;
    const ax = Math.cos(a) * radius;
    const az = Math.sin(a) * radius;
    const bx = Math.cos(b) * radius;
    const bz = Math.sin(b) * radius;
    const sideBase = arrays.positions.length / 3;
    addVertex(arrays, [center.x + ax, center.y - height * 0.5, center.z + az], [Math.cos(a), 0, Math.sin(a)], [0, 0]);
    addVertex(arrays, [center.x + bx, center.y - height * 0.5, center.z + bz], [Math.cos(b), 0, Math.sin(b)], [1, 0]);
    addVertex(arrays, [center.x + ax, center.y + height * 0.5, center.z + az], [Math.cos(a), 0, Math.sin(a)], [0, 1]);
    addVertex(arrays, [center.x + bx, center.y + height * 0.5, center.z + bz], [Math.cos(b), 0, Math.sin(b)], [1, 1]);
    arrays.indices.push(sideBase, sideBase + 1, sideBase + 2, sideBase + 1, sideBase + 3, sideBase + 2);
    const topA = addVertex(arrays, [center.x + ax, center.y + height * 0.5, center.z + az], [0, 1, 0], [0, 0]);
    const topB = addVertex(arrays, [center.x + bx, center.y + height * 0.5, center.z + bz], [0, 1, 0], [1, 0]);
    arrays.indices.push(topCenter, topA, topB);
    const bottomA = addVertex(arrays, [center.x + ax, center.y - height * 0.5, center.z + az], [0, -1, 0], [0, 0]);
    const bottomB = addVertex(arrays, [center.x + bx, center.y - height * 0.5, center.z + bz], [0, -1, 0], [1, 0]);
    arrays.indices.push(bottomCenter, bottomB, bottomA);
  }
}

function addEllipsoid(builder, center, radius, segments, rings, material) {
  const arrays = builderArrays(builder, material);
  const rowStart = [];
  for (let y = 0; y <= rings; y++) {
    const v = y / rings;
    const theta = v * Math.PI;
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    rowStart.push(arrays.positions.length / 3);
    for (let x = 0; x <= segments; x++) {
      const u = x / segments;
      const phi = u * Math.PI * 2;
      const nx = Math.cos(phi) * sinTheta;
      const ny = cosTheta;
      const nz = Math.sin(phi) * sinTheta;
      addVertex(
        arrays,
        [center.x + nx * radius.x, center.y + ny * radius.y, center.z + nz * radius.z],
        [nx, ny, nz],
        [u, v],
      );
    }
  }
  for (let y = 0; y < rings; y++) {
    for (let x = 0; x < segments; x++) {
      const a = rowStart[y] + x;
      const b = rowStart[y] + x + 1;
      const c = rowStart[y + 1] + x;
      const d = rowStart[y + 1] + x + 1;
      arrays.indices.push(a, c, b, b, c, d);
    }
  }
}

function addTorus(builder, center, majorRadius, tubeRadius, yaw, material) {
  const arrays = builderArrays(builder, material);
  const majorSegments = 28;
  const tubeSegments = 10;
  const rowStart = [];
  for (let i = 0; i <= majorSegments; i++) {
    const u = (i / majorSegments) * Math.PI * 2;
    const cu = Math.cos(u);
    const su = Math.sin(u);
    rowStart.push(arrays.positions.length / 3);
    for (let j = 0; j <= tubeSegments; j++) {
      const v = (j / tubeSegments) * Math.PI * 2;
      const cv = Math.cos(v);
      const sv = Math.sin(v);
      const localX = (majorRadius + tubeRadius * cv) * cu;
      const localY = tubeRadius * sv;
      const localZ = (majorRadius + tubeRadius * cv) * su;
      const [rx, rz] = rotateYaw(localX, localZ, yaw);
      const [nx, nz] = rotateYaw(cv * cu, cv * su, yaw);
      addVertex(arrays, [center.x + rx, center.y + localY, center.z + rz], [nx, sv, nz], [i / majorSegments, j / tubeSegments]);
    }
  }
  for (let i = 0; i < majorSegments; i++) {
    for (let j = 0; j < tubeSegments; j++) {
      const a = rowStart[i] + j;
      const b = rowStart[i] + j + 1;
      const c = rowStart[i + 1] + j;
      const d = rowStart[i + 1] + j + 1;
      arrays.indices.push(a, b, c, b, d, c);
    }
  }
}

function addTorusWithBasis(builder, center, majorRadius, tubeRadius, ringAxisA, ringAxisB, tubeAxis, material, majorSegments = 40, tubeSegments = 14) {
  const arrays = builderArrays(builder, material);
  const rowStart = [];
  for (let i = 0; i <= majorSegments; i++) {
    const u = (i / majorSegments) * Math.PI * 2;
    const cu = Math.cos(u);
    const su = Math.sin(u);
    const radial = vecNormalize(vecAdd(vecScale(ringAxisA, cu), vecScale(ringAxisB, su)));
    rowStart.push(arrays.positions.length / 3);
    for (let j = 0; j <= tubeSegments; j++) {
      const v = (j / tubeSegments) * Math.PI * 2;
      const cv = Math.cos(v);
      const sv = Math.sin(v);
      const normal = vecNormalize(vecAdd(vecScale(radial, cv), vecScale(tubeAxis, sv)));
      const pos = vecAdd(center, vecAdd(vecScale(radial, majorRadius + tubeRadius * cv), vecScale(tubeAxis, tubeRadius * sv)));
      addVertex(arrays, [pos.x, pos.y, pos.z], [normal.x, normal.y, normal.z], [i / majorSegments, j / tubeSegments]);
    }
  }
  for (let i = 0; i < majorSegments; i++) {
    for (let j = 0; j < tubeSegments; j++) {
      const a = rowStart[i] + j;
      const b = rowStart[i] + j + 1;
      const c = rowStart[i + 1] + j;
      const d = rowStart[i + 1] + j + 1;
      arrays.indices.push(a, b, c, b, d, c);
    }
  }
}

function addUprightTire(builder, center, yaw, majorRadius, tubeRadius, material) {
  const axes = axisFromYaw(yaw);
  addTorusWithBasis(builder, center, majorRadius, tubeRadius, axes.right, axes.up, axes.normal, material);
}

function addFlatTire(builder, center, yaw, outerRadius, innerRadius, material, detail = true) {
  const axes = axisFromYaw(yaw);
  const majorRadius = (outerRadius + innerRadius) * 0.5;
  const tubeRadius = (outerRadius - innerRadius) * 0.5;
  addTorusWithBasis(builder, center, majorRadius, tubeRadius, axes.right, axes.normal, axes.up, material, detail ? 64 : 28, detail ? 18 : 8);
  addCylinder(builder, { x: center.x, y: center.y - tubeRadius * 0.18, z: center.z }, innerRadius * 0.92, tubeRadius * 0.16, detail ? 36 : 20, SCENERY_MAT.tireHole);
  if (!detail) return;
  for (let i = 0; i < 36; i++) {
    const angle = (i / 36) * Math.PI * 2;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const radial = vecNormalize(vecAdd(vecScale(axes.right, ca), vecScale(axes.normal, sa)));
    const tangent = vecNormalize(vecAdd(vecScale(axes.right, -sa), vecScale(axes.normal, ca)));
    const grooveCenter = vecAdd(center, vecAdd(vecScale(radial, majorRadius + tubeRadius * 0.62), vecScale(axes.up, tubeRadius * 0.47)));
    addRoundedCuboid(
      builder,
      grooveCenter,
      tangent,
      axes.up,
      radial,
      { x: outerRadius * 0.16, y: tubeRadius * 0.08, z: tubeRadius * 0.52 },
      SCENERY_MAT.tireGroove,
      0.3,
      8,
      4,
    );
  }
  for (let i = 0; i < 18; i++) {
    const angle = ((i + 0.5) / 18) * Math.PI * 2;
    const radial = vecNormalize(vecAdd(vecScale(axes.right, Math.cos(angle)), vecScale(axes.normal, Math.sin(angle))));
    const tangent = vecNormalize(vecAdd(vecScale(axes.right, -Math.sin(angle)), vecScale(axes.normal, Math.cos(angle))));
    const ribCenter = vecAdd(center, vecAdd(vecScale(radial, innerRadius + tubeRadius * 0.22), vecScale(axes.up, tubeRadius * 0.38)));
    addRoundedCuboid(
      builder,
      ribCenter,
      tangent,
      axes.up,
      radial,
      { x: outerRadius * 0.13, y: tubeRadius * 0.07, z: tubeRadius * 0.32 },
      material,
      0.28,
      8,
      4,
    );
  }
}

function addFlatTireStack(builder, origin, yaw, offset, tireMaterials, scale, detail = true) {
  const s = scale;
  for (let layer = 0; layer < tireMaterials.length; layer++) {
    const center = localPoint(origin, yaw, offset.x * s, (offset.y + layer * 0.28) * s, offset.z * s);
    addFlatTire(builder, center, yaw, 0.58 * s, 0.255 * s, tireMaterials[layer], detail);
  }
}

function addCone(builder, center, radius, height, sides, material) {
  const arrays = builderArrays(builder, material);
  const tip = addVertex(arrays, [center.x, center.y + height * 0.5, center.z], [0, 1, 0], [0.5, 1]);
  const bottomCenter = addVertex(arrays, [center.x, center.y - height * 0.5, center.z], [0, -1, 0], [0.5, 0.5]);
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const b = ((i + 1) / sides) * Math.PI * 2;
    const ax = Math.cos(a) * radius;
    const az = Math.sin(a) * radius;
    const bx = Math.cos(b) * radius;
    const bz = Math.sin(b) * radius;
    const sideA = addVertex(arrays, [center.x + ax, center.y - height * 0.5, center.z + az], [Math.cos(a), 0.35, Math.sin(a)], [0, 0]);
    const sideB = addVertex(arrays, [center.x + bx, center.y - height * 0.5, center.z + bz], [Math.cos(b), 0.35, Math.sin(b)], [1, 0]);
    arrays.indices.push(sideA, sideB, tip);
    const bottomA = addVertex(arrays, [center.x + ax, center.y - height * 0.5, center.z + az], [0, -1, 0], [0, 0]);
    const bottomB = addVertex(arrays, [center.x + bx, center.y - height * 0.5, center.z + bz], [0, -1, 0], [1, 0]);
    arrays.indices.push(bottomCenter, bottomB, bottomA);
  }
}

function curveSideAt(distance) {
  const a = trackPointAtDistance(distance - 4);
  const b = trackPointAtDistance(distance + 4);
  const cross = a.tan.x * b.tan.z - a.tan.z * b.tan.x;
  return cross >= 0 ? 1 : -1;
}

function addArrowSign(builder, distance) {
	const side = curveSideAt(distance);
	const p = offsetTrackPoint(distance, side * (trackWidth * 0.5 + 13.8), 1.55);
	const yaw = p.yaw + (side > 0 ? -Math.PI * 0.5 : Math.PI * 0.5);
	addCylinder(builder, { x: p.x - p.left.x * side * 0.46, y: p.y - 0.78, z: p.z - p.left.z * side * 0.46 }, 0.065, 1.55, 10, 5);
	addCylinder(builder, { x: p.x + p.left.x * side * 0.46, y: p.y - 0.78, z: p.z + p.left.z * side * 0.46 }, 0.065, 1.55, 10, 5);
	addBox(builder, p, { x: 2.15, y: 0.86, z: 0.12 }, yaw, 6);
	addBox(builder, { x: p.x, y: p.y, z: p.z - 0.08 }, { x: 1.25, y: 0.18, z: 0.06 }, yaw, 7);
	const tip = { x: p.x + p.left.x * side * 0.58, y: p.y, z: p.z + p.left.z * side * 0.58 };
	addBox(builder, tip, { x: 0.42, y: 0.42, z: 0.08 }, yaw + Math.PI * 0.25 * side, 7);
}

function addPremiumCornerMarker(builder, distance, lateral, scale = 1) {
  const p = offsetTrackPoint(distance, lateral, 0);
  const yaw = Math.atan2(p.tan.z, p.tan.x);
  const faceSign = lateral >= 0 ? -1 : 1;
  addPremiumCornerMarkerAt(builder, { x: p.x, y: p.y, z: p.z }, yaw, faceSign, scale);
}

function addPremiumCornerMarkerAt(builder, origin, yaw, faceSign, scale) {
  const s = scale;
  const front = faceSign;
  addRoundedLocalBox(builder, origin, yaw, { x: 0, y: 0.18 * s, z: front * 0.34 * s }, { x: 6.7 * s, y: 0.36 * s, z: 1.55 * s }, 0, 16, 0.22, 32, 10);
  addRoundedLocalBox(builder, origin, yaw, { x: 0, y: 0.46 * s, z: front * 0.96 * s }, { x: 6.1 * s, y: 0.16 * s, z: 0.2 * s }, 0, 20, 0.2, 24, 8);
  addRoundedLocalBox(builder, origin, yaw, { x: 0, y: 0.5 * s, z: -front * 0.36 * s }, { x: 5.9 * s, y: 0.18 * s, z: 0.28 * s }, 0, 9, 0.2, 24, 8);

  for (const sx of [-2.35, 2.35]) {
    const post = localPoint(origin, yaw, sx * s, 1.46 * s, -front * 0.18 * s);
    addCylinder(builder, post, 0.14 * s, 2.72 * s, 22, 19);
    addCylinder(builder, localPoint(origin, yaw, sx * s, 0.25 * s, -front * 0.18 * s), 0.42 * s, 0.26 * s, 26, 20);
    addEllipsoid(builder, localPoint(origin, yaw, sx * s, 2.88 * s, -front * 0.18 * s), { x: 0.24 * s, y: 0.11 * s, z: 0.24 * s }, 18, 8, 20);
  }

  addRoundedLocalBox(builder, origin, yaw, { x: 0, y: 2.7 * s, z: 0 }, { x: 6.0 * s, y: 2.38 * s, z: 0.42 * s }, 0, 20, 0.22, 36, 16);
  addRoundedLocalBox(builder, origin, yaw, { x: 0, y: 2.7 * s, z: front * 0.27 * s }, { x: 5.56 * s, y: 1.96 * s, z: 0.16 * s }, 0, 11, 0.2, 36, 14);
  addRoundedLocalBox(builder, origin, yaw, { x: 0, y: 3.78 * s, z: front * 0.35 * s }, { x: 5.92 * s, y: 0.24 * s, z: 0.22 * s }, 0, 25, 0.18, 28, 8);
  addRoundedLocalBox(builder, origin, yaw, { x: 0, y: 1.62 * s, z: front * 0.35 * s }, { x: 5.92 * s, y: 0.24 * s, z: 0.22 * s }, 0, 25, 0.18, 28, 8);
  addRoundedLocalBox(builder, origin, yaw, { x: -2.88 * s, y: 2.7 * s, z: front * 0.35 * s }, { x: 0.24 * s, y: 2.18 * s, z: 0.22 * s }, 0, 25, 0.18, 14, 10);
  addRoundedLocalBox(builder, origin, yaw, { x: 2.88 * s, y: 2.7 * s, z: front * 0.35 * s }, { x: 0.24 * s, y: 2.18 * s, z: 0.22 * s }, 0, 25, 0.18, 14, 10);

  for (const tipX of [-1.48, 0.18, 1.84]) {
    const lengthBase = 1.48;
    const length = lengthBase * s;
    const angle = 0.62;
    const stemX = (tipX - Math.cos(angle) * lengthBase * 0.5) * s;
    const topY = (2.7 + Math.sin(angle) * lengthBase * 0.5) * s;
    const bottomY = (2.7 - Math.sin(angle) * lengthBase * 0.5) * s;
    addRoundedPanelBar(builder, origin, yaw, { x: stemX, y: topY, z: front * 0.5 * s }, length, 0.33 * s, 0.13 * s, -angle, front, 26);
    addRoundedPanelBar(builder, origin, yaw, { x: stemX, y: bottomY, z: front * 0.5 * s }, length, 0.33 * s, 0.13 * s, angle, front, 26);
  }

  for (const bx of [-2.55, -1.0, 1.0, 2.55]) {
    for (const by of [1.82, 3.58]) {
      addEllipsoid(builder, localPoint(origin, yaw, bx * s, by * s, front * 0.58 * s), { x: 0.085 * s, y: 0.085 * s, z: 0.085 * s }, 12, 6, 19);
      addEllipsoid(builder, localPoint(origin, yaw, bx * s, by * s, front * 0.64 * s), { x: 0.04 * s, y: 0.04 * s, z: 0.04 * s }, 8, 4, 25);
    }
  }

  for (let i = 0; i < 14; i++) {
    const x = (-3.0 + i * 0.46) * s;
    const z = front * (1.5 + (i % 4) * 0.18) * s;
    const h = (0.36 + (i % 3) * 0.08) * s;
    const ground = localPoint(origin, yaw, x, 0.22 * s, z);
    addCone(builder, { x: ground.x, y: ground.y + h * 0.42, z: ground.z }, 0.095 * s, h, 7, i % 2 === 0 ? 14 : 15);
    if (i % 3 === 0) {
      addEllipsoid(builder, localPoint(origin, yaw, x, (0.58 + (i % 2) * 0.05) * s, z), { x: 0.075 * s, y: 0.055 * s, z: 0.075 * s }, 10, 5, i % 2 === 0 ? 22 : 11);
    }
  }
}

function addMaterialShowcase(builder, distance, lateral, scale = 1) {
  const p = offsetTrackPoint(distance, lateral, 0);
  const yaw = Math.atan2(p.tan.z, p.tan.x);
  const front = lateral >= 0 ? -1 : 1;
  addMaterialShowcaseAt(builder, { x: p.x, y: p.y, z: p.z }, yaw, front, scale);
}

function addMaterialShowcaseAt(builder, origin, yaw, faceSign, scale) {
  const s = scale;
  const front = faceSign;
  addRoundedLocalBox(builder, origin, yaw, { x: 0, y: 0.12 * s, z: front * 0.24 * s }, { x: 8.8 * s, y: 0.24 * s, z: 2.1 * s }, 0, 20, 0.22, 36, 10);
  addRoundedLocalBox(builder, origin, yaw, { x: 0, y: 0.28 * s, z: front * 0.42 * s }, { x: 8.35 * s, y: 0.08 * s, z: 1.66 * s }, 0, 25, 0.2, 30, 8);
  addRoundedLocalBox(builder, origin, yaw, { x: 0, y: 0.34 * s, z: front * 0.42 * s }, { x: 7.75 * s, y: 0.06 * s, z: 1.16 * s }, 0, 27, 0.2, 30, 8);

  const xs = [-3.2, -1.6, 0, 1.6, 3.2];
  for (const x of xs) {
    addRoundedLocalBox(builder, origin, yaw, { x: x * s, y: 0.56 * s, z: front * 0.22 * s }, { x: 1.08 * s, y: 0.34 * s, z: 0.84 * s }, 0, 20, 0.25, 20, 10);
  }

  addRoundedLocalBox(builder, origin, yaw, { x: -3.2 * s, y: 1.08 * s, z: front * 0.22 * s }, { x: 1.0 * s, y: 1.0 * s, z: 0.16 * s }, 0, 11, 0.2, 24, 12);
  addRoundedPanelBar(builder, origin, yaw, { x: -3.28 * s, y: 1.08 * s, z: front * 0.33 * s }, 0.78 * s, 0.15 * s, 0.08 * s, 0.65 * front, front, 26);
  addRoundedPanelBar(builder, origin, yaw, { x: -3.05 * s, y: 1.08 * s, z: front * 0.34 * s }, 0.78 * s, 0.15 * s, 0.08 * s, -0.65 * front, front, 26);
  addEllipsoid(builder, localPoint(origin, yaw, -3.64 * s, 1.6 * s, front * 0.35 * s), { x: 0.06 * s, y: 0.06 * s, z: 0.06 * s }, 10, 5, 19);
  addEllipsoid(builder, localPoint(origin, yaw, -2.76 * s, 1.6 * s, front * 0.35 * s), { x: 0.06 * s, y: 0.06 * s, z: 0.06 * s }, 10, 5, 19);

  addUprightTire(builder, localPoint(origin, yaw, -1.6 * s, 1.08 * s, front * 0.25 * s), yaw, 0.46 * s, 0.16 * s, 8);
  addUprightTire(builder, localPoint(origin, yaw, -1.6 * s, 1.08 * s, front * 0.35 * s), yaw, 0.28 * s, 0.035 * s, 11);
  addUprightTire(builder, localPoint(origin, yaw, -1.24 * s, 0.78 * s, front * 0.34 * s), yaw, 0.28 * s, 0.1 * s, 8);

  addCylinder(builder, localPoint(origin, yaw, 0, 1.0 * s, front * 0.18 * s), 0.13 * s, 0.78 * s, 24, 20);
  addEllipsoid(builder, localPoint(origin, yaw, 0, 1.58 * s, front * 0.18 * s), { x: 0.46 * s, y: 0.46 * s, z: 0.46 * s }, 24, 12, 19);
  addEllipsoid(builder, localPoint(origin, yaw, 0.24 * s, 1.78 * s, front * 0.46 * s), { x: 0.11 * s, y: 0.06 * s, z: 0.11 * s }, 12, 6, 25);

  for (let i = 0; i < 11; i++) {
    const x = (1.22 + i * 0.075) * s;
    const z = front * (0.08 + (i % 4) * 0.12) * s;
    const h = (0.5 + (i % 3) * 0.12) * s;
    const base = localPoint(origin, yaw, x, 0.86 * s, z);
    addCone(builder, { x: base.x, y: base.y + h * 0.45, z: base.z }, 0.12 * s, h, 8, i % 2 === 0 ? 14 : 15);
  }
  for (const x of [1.28, 1.74, 2.05]) {
    addEllipsoid(builder, localPoint(origin, yaw, x * s, 1.42 * s, front * 0.55 * s), { x: 0.08 * s, y: 0.06 * s, z: 0.08 * s }, 10, 5, x > 1.7 ? 22 : 11);
  }

  addRoundedLocalBox(builder, origin, yaw, { x: 3.2 * s, y: 0.94 * s, z: front * 0.22 * s }, { x: 1.16 * s, y: 0.14 * s, z: 0.96 * s }, 0, 27, 0.2, 22, 8);
  addRoundedLocalBox(builder, origin, yaw, { x: 3.2 * s, y: 1.04 * s, z: front * 0.22 * s }, { x: 0.12 * s, y: 0.04 * s, z: 0.9 * s }, 0, 11, 0.18, 14, 6);
  addRoundedLocalBox(builder, origin, yaw, { x: 2.76 * s, y: 1.05 * s, z: front * 0.22 * s }, { x: 0.08 * s, y: 0.045 * s, z: 0.92 * s }, 0, 25, 0.18, 14, 6);
  addRoundedLocalBox(builder, origin, yaw, { x: 3.64 * s, y: 1.05 * s, z: front * 0.22 * s }, { x: 0.08 * s, y: 0.045 * s, z: 0.92 * s }, 0, 25, 0.18, 14, 6);
}

function addTireBarrier(builder, distance, lateral, scale = 1, detail = false) {
  const p = offsetTrackPoint(distance, lateral, 0.16);
  const colors = [SCENERY_MAT.tireRed, SCENERY_MAT.tireCream, SCENERY_MAT.tireGrey, SCENERY_MAT.tireDark];
  for (let i = 0; i < 3; i++) {
    const stack = i === 1
      ? [colors[i], colors[(i + 2) % colors.length], colors[(i + 1) % colors.length]]
      : [colors[i], colors[(i + 1) % colors.length]];
    addFlatTireStack(builder, { x: p.x, y: p.y, z: p.z }, p.yaw, { x: (i - 1) * 0.9, y: 0.18, z: 0 }, stack, 0.78 * scale, detail);
  }
}

function addTracksideTireBarriers(builder) {
  addTireBarrier(builder, 31, trackWidth * 0.5 + 8.4, 1.22, false);
  addTireBarrier(builder, totalDistance * 0.11, -trackWidth * 0.5 - 10.5, 1.0, false);
  for (let i = 0; i < 9; i++) {
    addTireBarrier(builder, totalDistance * (0.08 + i * 0.056), -trackWidth * 0.5 - 6.7, 0.72, false);
  }
  for (let i = 0; i < 9; i++) {
    addTireBarrier(builder, totalDistance * (0.55 + i * 0.04), trackWidth * 0.5 + 6.7, 0.72, false);
  }
}

function addFenceSegment(builder, distanceA, distanceB, lateral) {
  const a = offsetTrackPoint(distanceA, lateral, 1.2);
  const b = offsetTrackPoint(distanceB, lateral, 1.2);
  addCylinder(builder, { x: a.x, y: a.y - 0.5, z: a.z }, 0.09, 1.65, 8, 5);
  addCylinder(builder, { x: b.x, y: b.y - 0.5, z: b.z }, 0.09, 1.65, 8, 5);
  addBeamBetween(builder, { x: a.x, y: a.y, z: a.z }, { x: b.x, y: b.y, z: b.z }, 0.14, 9);
  addBeamBetween(builder, { x: a.x, y: a.y - 0.46, z: a.z }, { x: b.x, y: b.y - 0.46, z: b.z }, 0.12, 9);
}

function addStartArch(builder) {
  const p = offsetTrackPoint(0, 0, 0);
  const left = offsetTrackPoint(0, -trackWidth * 0.56, 3.0);
  const right = offsetTrackPoint(0, trackWidth * 0.56, 3.0);
  addBox(builder, left, { x: 0.8, y: 6.0, z: 0.8 }, p.yaw, 10);
  addBox(builder, right, { x: 0.8, y: 6.0, z: 0.8 }, p.yaw, 10);
  addBeamBetween(builder, left, right, 0.9, 11);
  for (let i = -3; i <= 3; i++) {
    const flag = offsetTrackPoint(0, i * 2.5, 6.5);
    addBox(builder, flag, { x: 1.25, y: 0.8, z: 0.08 }, p.yaw, i % 2 === 0 ? 12 : 6);
  }
}

function addTree(builder, x, z, scale) {
  const y = terrainWorldY(x, z);
  addCylinder(builder, { x, y: y + scale * 0.9, z }, 0.18 * scale, 1.8 * scale, 8, 13);
  addCone(builder, { x, y: y + scale * 2.35, z }, 1.05 * scale, 2.45 * scale, 10, 14);
  addCone(builder, { x, y: y + scale * 3.05, z }, 0.72 * scale, 1.8 * scale, 10, 15);
}

function addRock(builder, x, z, scale) {
	const y = terrainWorldY(x, z) + scale * 0.25;
	addBox(builder, { x, y, z }, { x: scale * 1.6, y: scale * 0.8, z: scale * 1.25 }, noise2(Math.floor(x), Math.floor(z)) * Math.PI, 16);
}

function addDistantHill(builder, x, z, radius, height, material) {
	const y = terrainWorldY(clamp(x, -terrainWidth * 0.48, terrainWidth * 0.48), clamp(z, -terrainDepth * 0.48, terrainDepth * 0.48));
	addCone(builder, { x, y: y + height * 0.5 - 1.2, z }, radius, height, 18, material);
}

function addToyCloud(builder, x, y, z, scale, yaw = 0) {
  const origin = { x, y, z };
  const parts = [
    { x: 0, y: 0.05, z: 0, r: { x: 3.8, y: 1.55, z: 1.55 }, material: 0 },
    { x: -2.65, y: -0.15, z: -0.08, r: { x: 1.55, y: 1.05, z: 1.05 }, material: 2 },
    { x: -1.18, y: 0.66, z: 0.08, r: { x: 2.18, y: 1.68, z: 1.38 }, material: 0 },
    { x: 1.12, y: 0.78, z: -0.04, r: { x: 2.38, y: 1.82, z: 1.44 }, material: 0 },
    { x: 2.92, y: -0.12, z: 0.05, r: { x: 1.72, y: 1.12, z: 1.08 }, material: 2 },
    { x: 4.22, y: -0.42, z: -0.02, r: { x: 0.86, y: 0.66, z: 0.66 }, material: 0 },
  ];
  for (const part of parts) {
    addEllipsoid(
      builder,
      localPoint(origin, yaw, part.x * scale, part.y * scale, part.z * scale),
      { x: part.r.x * scale, y: part.r.y * scale, z: part.r.z * scale },
      24,
      12,
      part.material,
    );
  }
}

function addToyCloudLayer(builder) {
  addToyCloud(builder, -42, 55, 36, 6.6, 0.02);
  addToyCloud(builder, 96, 60, 18, 5.4, -0.18);
  addToyCloud(builder, -78, 47, 98, 8.2, 0.08);
  addToyCloud(builder, 46, 56, 82, 5.7, -0.22);
  addToyCloud(builder, 128, 62, -42, 6.0, 0.18);
  addToyCloud(builder, -150, 60, -86, 5.25, -0.1);
  addToyCloud(builder, 214, 56, 142, 2.85, 0.35);
  addToyCloud(builder, -212, 57, 18, 3.05, -0.3);
  addToyCloud(builder, 10, 75, -176, 3.7, 0.12);
}

function addBushCluster(builder, x, z, scale) {
  const y = terrainWorldY(x, z);
  const rnd = random((Math.floor((x + 310) * 17) ^ Math.floor((z + 290) * 29)) >>> 0);
  const count = 4 + Math.floor(rnd() * 3);
  for (let i = 0; i < count; i++) {
    const angle = rnd() * Math.PI * 2;
    const radius = scale * (0.15 + rnd() * 0.92);
    const bx = x + Math.cos(angle) * radius;
    const bz = z + Math.sin(angle) * radius;
    const leaf = i % 3 === 0 ? 15 : (i % 3 === 1 ? 14 : 17);
    addEllipsoid(
      builder,
      { x: bx, y: y + scale * (0.28 + rnd() * 0.18), z: bz },
      { x: scale * (0.46 + rnd() * 0.24), y: scale * (0.36 + rnd() * 0.16), z: scale * (0.46 + rnd() * 0.24) },
      16,
      8,
      leaf,
    );
  }
  if (scale > 0.82) {
    addRock(builder, x + scale * 1.05, z - scale * 0.48, scale * 0.34);
  }
}

function addBushClusterAtTrack(builder, distance, lateral, scale) {
  const p = offsetTrackPoint(distance, lateral, 0);
  addBushCluster(builder, p.x, p.z, scale);
}

function addToyPond(builder, x, z, scale, yaw = 0) {
  const y = terrainWorldY(x, z) + 0.1;
  const origin = { x, y, z };
  const axes = axisFromYaw(yaw);
  addRoundedCuboid(builder, origin, axes.right, axes.up, axes.normal, { x: 54 * scale, y: 0.18 * scale, z: 30 * scale }, SCENERY_MAT.water, 0.42, 42, 12);
  for (const stripe of [-0.28, 0.18, 0.46]) {
    addRoundedLocalBox(builder, origin, yaw, { x: stripe * 38 * scale, y: 0.16 * scale, z: -4.0 * scale }, { x: 12.0 * scale, y: 0.045 * scale, z: 1.15 * scale }, 0.18, 4, 0.28, 20, 6);
  }
  for (let i = 0; i < 18; i++) {
    const angle = (i / 18) * Math.PI * 2;
    const rx = Math.cos(angle) * (29 + (i % 3) * 1.8) * scale;
    const rz = Math.sin(angle) * (16 + (i % 4) * 1.1) * scale;
    const ground = localPoint(origin, yaw, rx, 0.05 * scale, rz);
    addRoundedCuboid(builder, ground, axes.right, axes.up, axes.normal, { x: 2.0 * scale, y: 0.9 * scale, z: 1.45 * scale }, i % 2 === 0 ? 16 : 25, 0.32, 12, 6);
  }
}

function addToyBridge(builder, x, z, scale, yaw = 0) {
  const y = terrainWorldY(x, z) + 0.8 * scale;
  const origin = { x, y, z };
  addRoundedLocalBox(builder, origin, yaw, { x: 0, y: 0.55 * scale, z: 0 }, { x: 42 * scale, y: 1.05 * scale, z: 7.2 * scale }, 0, 25, 0.3, 36, 10);
  addRoundedLocalBox(builder, origin, yaw, { x: 0, y: 1.18 * scale, z: 0 }, { x: 40.5 * scale, y: 0.16 * scale, z: 5.55 * scale }, 0, 27, 0.25, 32, 6);
  for (const side of [-1, 1]) {
    for (let i = -4; i <= 4; i++) {
      addRoundedLocalBox(builder, origin, yaw, { x: i * 4.6 * scale, y: 2.0 * scale, z: side * 4.18 * scale }, { x: 0.38 * scale, y: 1.55 * scale, z: 0.38 * scale }, 0, 16, 0.24, 12, 6);
    }
    addRoundedLocalBox(builder, origin, yaw, { x: 0, y: 2.42 * scale, z: side * 4.18 * scale }, { x: 41 * scale, y: 0.28 * scale, z: 0.28 * scale }, 0, 13, 0.24, 28, 6);
    addRoundedLocalBox(builder, origin, yaw, { x: 0, y: 1.72 * scale, z: side * 4.18 * scale }, { x: 41 * scale, y: 0.22 * scale, z: 0.22 * scale }, 0, 13, 0.24, 28, 6);
    for (const archX of [-13.5, 0, 13.5]) {
      addRoundedLocalBox(builder, origin, yaw, { x: archX * scale, y: 0.62 * scale, z: side * 3.72 * scale }, { x: 6.4 * scale, y: 0.52 * scale, z: 0.3 * scale }, 0, 16, 0.22, 18, 6);
      addRoundedLocalBox(builder, origin, yaw, { x: (archX - 3.4) * scale, y: -0.08 * scale, z: side * 3.72 * scale }, { x: 0.54 * scale, y: 1.32 * scale, z: 0.32 * scale }, 0, 16, 0.22, 12, 6);
      addRoundedLocalBox(builder, origin, yaw, { x: (archX + 3.4) * scale, y: -0.08 * scale, z: side * 3.72 * scale }, { x: 0.54 * scale, y: 1.32 * scale, z: 0.32 * scale }, 0, 16, 0.22, 12, 6);
    }
  }
}

function addToyTower(builder, x, z, scale, yaw = 0) {
  const y = terrainWorldY(x, z);
  const origin = { x, y, z };
  addRoundedLocalBox(builder, origin, yaw, { x: 0, y: 0.42 * scale, z: 0 }, { x: 12.5 * scale, y: 0.84 * scale, z: 10.5 * scale }, 0, 17, 0.32, 28, 8);
  addRoundedLocalBox(builder, origin, yaw, { x: 0, y: 3.25 * scale, z: 0 }, { x: 4.7 * scale, y: 5.85 * scale, z: 4.7 * scale }, 0, 25, 0.25, 28, 12);
  addRoundedLocalBox(builder, origin, yaw, { x: 0, y: 6.55 * scale, z: 0 }, { x: 6.2 * scale, y: 1.2 * scale, z: 6.2 * scale }, 0, 25, 0.22, 28, 8);
  addCone(builder, localPoint(origin, yaw, 0, 8.12 * scale, 0), 4.6 * scale, 3.05 * scale, 4, 21);
  addRoundedLocalBox(builder, origin, yaw, { x: 0, y: 1.3 * scale, z: -2.41 * scale }, { x: 1.14 * scale, y: 1.85 * scale, z: 0.16 * scale }, 0, 26, 0.2, 16, 8);
  for (const wx of [-1.35, 1.35]) {
    addRoundedLocalBox(builder, origin, yaw, { x: wx * scale, y: 4.2 * scale, z: -2.43 * scale }, { x: 0.82 * scale, y: 0.9 * scale, z: 0.14 * scale }, 0, 12, 0.2, 14, 6);
  }
  for (const wz of [-1.85, 1.85]) {
    addRoundedLocalBox(builder, origin, yaw, { x: -2.43 * scale, y: 4.2 * scale, z: wz * scale }, { x: 0.14 * scale, y: 0.9 * scale, z: 0.82 * scale }, 0, 12, 0.2, 14, 6);
    addRoundedLocalBox(builder, origin, yaw, { x: 2.43 * scale, y: 4.2 * scale, z: wz * scale }, { x: 0.14 * scale, y: 0.9 * scale, z: 0.82 * scale }, 0, 12, 0.2, 14, 6);
  }
  for (const side of [-1, 1]) {
    for (let i = -2; i <= 2; i++) {
      addRoundedLocalBox(builder, origin, yaw, { x: i * 2.15 * scale, y: 1.22 * scale, z: side * 5.72 * scale }, { x: 0.24 * scale, y: 1.25 * scale, z: 0.24 * scale }, 0, 13, 0.23, 10, 5);
    }
    addRoundedLocalBox(builder, origin, yaw, { x: 0, y: 1.65 * scale, z: side * 5.72 * scale }, { x: 10.5 * scale, y: 0.25 * scale, z: 0.22 * scale }, 0, 13, 0.23, 20, 5);
  }
  addTree(builder, x - 8.2 * Math.cos(yaw), z - 8.2 * Math.sin(yaw), 0.9 * scale);
  addTree(builder, x + 7.2 * Math.cos(yaw + 0.7), z + 7.2 * Math.sin(yaw + 0.7), 0.72 * scale);
}

function addToyTowerNearTrack(builder, distance, lateral, scale) {
  const p = offsetTrackPoint(distance, lateral, 0);
  addToyTower(builder, p.x, p.z, scale, p.yaw + Math.PI * 0.5);
}

function addToyTunnelPortal(builder, distance, lateral, scale) {
  const p = offsetTrackPoint(distance, lateral, 0);
  const side = lateral >= 0 ? 1 : -1;
  const yaw = p.yaw + side * Math.PI * 0.5;
  const origin = { x: p.x, y: terrainWorldY(p.x, p.z), z: p.z };
  const s = scale;
  addRoundedLocalBox(builder, origin, yaw, { x: 0, y: 0.28 * s, z: 1.05 * s }, { x: 16.5 * s, y: 0.56 * s, z: 7.2 * s }, 0, 16, 0.24, 28, 8);
  addRoundedLocalBox(builder, origin, yaw, { x: -6.35 * s, y: 3.4 * s, z: 0 }, { x: 2.5 * s, y: 6.35 * s, z: 5.2 * s }, 0, 16, 0.24, 24, 10);
  addRoundedLocalBox(builder, origin, yaw, { x: 6.35 * s, y: 3.4 * s, z: 0 }, { x: 2.5 * s, y: 6.35 * s, z: 5.2 * s }, 0, 16, 0.24, 24, 10);
  addRoundedLocalBox(builder, origin, yaw, { x: 0, y: 6.42 * s, z: 0 }, { x: 15.2 * s, y: 2.65 * s, z: 5.2 * s }, 0, 16, 0.24, 30, 10);
  addRoundedLocalBox(builder, origin, yaw, { x: 0, y: 3.1 * s, z: -2.72 * s }, { x: 9.1 * s, y: 4.6 * s, z: 0.28 * s }, 0, 32, 0.22, 24, 8);
  for (let i = -3; i <= 3; i++) {
    const mat = i % 2 === 0 ? 25 : 16;
    addRoundedLocalBox(builder, origin, yaw, { x: i * 2.14 * s, y: 7.86 * s, z: -2.86 * s }, { x: 1.58 * s, y: 0.58 * s, z: 0.34 * s }, 0, mat, 0.24, 12, 5);
  }
  for (const xOffset of [-7.8, 7.8]) {
    addBushCluster(builder, origin.x + Math.cos(yaw) * xOffset * s, origin.z + Math.sin(yaw) * xOffset * s, 1.0 * s);
  }
}

const SCENERY_TEXTURE = {
  yellowPaint: 0,
  yellowPaintNormal: 1,
  yellowPaintMr: 2,
  rubber: 3,
  rubberNormal: 4,
  rubberMr: 5,
  metal: 6,
  metalNormal: 7,
  metalMr: 8,
  darkMetal: 9,
  darkMetalMr: 10,
  leaf: 11,
  leafNormal: 12,
  leafMr: 13,
  creamPaint: 14,
  creamPaintNormal: 15,
  creamPaintMr: 16,
  blackPaint: 17,
  blackPaintNormal: 18,
  blackPaintMr: 19,
  asphalt: 20,
  asphaltNormal: 21,
  asphaltMr: 22,
  bluePaint: 23,
  bluePaintNormal: 24,
  bluePaintMr: 25,
  redPaint: 26,
  redPaintNormal: 27,
  redPaintMr: 28,
  tireRed: 29,
  tireCream: 30,
  tireGrey: 31,
  tireDark: 32,
};

const SCENERY_IMAGES = makeSceneryImages();
const SCENERY_TEXTURES = SCENERY_IMAGES.map((_, source) => ({ source }));

const SCENERY_MATERIALS = [
  { color: [1, 1, 1, 1] },
  { color: [1, 1, 1, 1], texture: SCENERY_TEXTURE.redPaint, normalTexture: SCENERY_TEXTURE.redPaintNormal, mrTexture: SCENERY_TEXTURE.redPaintMr, roughness: 0.4 },
  { color: [0.96, 0.98, 0.9, 1] },
  { color: [0.55, 0.68, 0.28, 1] },
  { color: [0.08, 0.82, 1, 1], emissive: [0.0, 0.38, 0.62] },
  { color: [0.72, 0.52, 0.31, 1] },
  { color: [1.0, 0.74, 0.12, 1] },
  { color: [1, 1, 1, 1], texture: SCENERY_TEXTURE.bluePaint, normalTexture: SCENERY_TEXTURE.bluePaintNormal, mrTexture: SCENERY_TEXTURE.bluePaintMr, roughness: 0.38 },
  { color: [1, 1, 1, 1], texture: SCENERY_TEXTURE.rubber, normalTexture: SCENERY_TEXTURE.rubberNormal, mrTexture: SCENERY_TEXTURE.rubberMr, roughness: 0.9 },
  { color: [0.95, 0.92, 0.75, 1] },
  { color: [1, 1, 1, 1], texture: SCENERY_TEXTURE.redPaint, normalTexture: SCENERY_TEXTURE.redPaintNormal, mrTexture: SCENERY_TEXTURE.redPaintMr, roughness: 0.4 },
  { color: [1, 1, 1, 1], texture: SCENERY_TEXTURE.yellowPaint, normalTexture: SCENERY_TEXTURE.yellowPaintNormal, mrTexture: SCENERY_TEXTURE.yellowPaintMr, roughness: 0.42 },
  { color: [0.06, 0.53, 0.95, 1] },
  { color: [0.48, 0.32, 0.18, 1] },
  { color: [0.82, 1.0, 0.82, 1], texture: SCENERY_TEXTURE.leaf, normalTexture: SCENERY_TEXTURE.leafNormal, mrTexture: SCENERY_TEXTURE.leafMr, roughness: 0.58 },
  { color: [1.0, 1.0, 0.86, 1], texture: SCENERY_TEXTURE.leaf, normalTexture: SCENERY_TEXTURE.leafNormal, mrTexture: SCENERY_TEXTURE.leafMr, roughness: 0.58 },
  { color: [0.46, 0.50, 0.52, 1] },
  { color: [0.33, 0.70, 0.36, 1] },
  { color: [0.28, 0.56, 0.50, 1] },
  { color: [1, 1, 1, 1], texture: SCENERY_TEXTURE.metal, normalTexture: SCENERY_TEXTURE.metalNormal, mrTexture: SCENERY_TEXTURE.metalMr, metallic: 0.85, roughness: 0.36 },
  { color: [1, 1, 1, 1], texture: SCENERY_TEXTURE.darkMetal, normalTexture: SCENERY_TEXTURE.metalNormal, mrTexture: SCENERY_TEXTURE.darkMetalMr, metallic: 0.9, roughness: 0.42 },
  { color: [1.0, 0.40, 0.14, 1], roughness: 0.42 },
  { color: [1.0, 0.62, 0.86, 1], roughness: 0.48 },
  { color: [1, 1, 1, 1], texture: SCENERY_TEXTURE.bluePaint, normalTexture: SCENERY_TEXTURE.bluePaintNormal, mrTexture: SCENERY_TEXTURE.bluePaintMr, roughness: 0.38 },
  { color: [0.02, 0.024, 0.028, 1], roughness: 0.88 },
  { color: [1, 1, 1, 1], texture: SCENERY_TEXTURE.creamPaint, normalTexture: SCENERY_TEXTURE.creamPaintNormal, mrTexture: SCENERY_TEXTURE.creamPaintMr, roughness: 0.4 },
  { color: [1, 1, 1, 1], texture: SCENERY_TEXTURE.blackPaint, normalTexture: SCENERY_TEXTURE.blackPaintNormal, mrTexture: SCENERY_TEXTURE.blackPaintMr, roughness: 0.52 },
  { color: [1, 1, 1, 1], texture: SCENERY_TEXTURE.asphalt, normalTexture: SCENERY_TEXTURE.asphaltNormal, mrTexture: SCENERY_TEXTURE.asphaltMr, roughness: 0.82 },
  { color: [1, 1, 1, 1], texture: SCENERY_TEXTURE.tireRed, normalTexture: SCENERY_TEXTURE.rubberNormal, mrTexture: SCENERY_TEXTURE.rubberMr, roughness: 0.78 },
  { color: [1, 1, 1, 1], texture: SCENERY_TEXTURE.tireCream, normalTexture: SCENERY_TEXTURE.rubberNormal, mrTexture: SCENERY_TEXTURE.rubberMr, roughness: 0.8 },
  { color: [1, 1, 1, 1], texture: SCENERY_TEXTURE.tireGrey, normalTexture: SCENERY_TEXTURE.rubberNormal, mrTexture: SCENERY_TEXTURE.rubberMr, roughness: 0.84 },
  { color: [1, 1, 1, 1], texture: SCENERY_TEXTURE.tireDark, normalTexture: SCENERY_TEXTURE.rubberNormal, mrTexture: SCENERY_TEXTURE.rubberMr, roughness: 0.88 },
  { color: [0.002, 0.003, 0.004, 1], roughness: 0.96 },
  { color: [0.055, 0.05, 0.045, 1], roughness: 0.94 },
  { color: [0.10, 0.74, 1.0, 1], emissive: [0.0, 0.16, 0.28], roughness: 0.18 },
];

const SCENERY_MAT = {
  cloud: 0,
  cloudWarm: 2,
  wood: 13,
  leaf: 14,
  lightLeaf: 15,
  stone: 16,
  grassMound: 17,
  orangePaint: 21,
  skyBluePaint: 23,
  blackPaint: 26,
  asphalt: 27,
  tireRed: 28,
  tireCream: 29,
  tireGrey: 30,
  tireDark: 31,
  tireHole: 32,
  tireGroove: 33,
  water: 34,
};

function makeSceneryGlb() {
	const builder = makeBuilder();
	addToyCloudLayer(builder);
	addDistantHill(builder, -184, -232, 48, 26, 17);
	addDistantHill(builder, -118, -244, 38, 21, 18);
	addDistantHill(builder, 150, -236, 54, 29, 17);
	addDistantHill(builder, 210, -182, 42, 24, 18);
	addDistantHill(builder, -210, 170, 46, 23, 17);
	addDistantHill(builder, 196, 192, 52, 27, 18);
	addToyPond(builder, 6, -14, 1.0, -0.16);
	addToyBridge(builder, 4, -16, 0.95, -0.16);
	addToyTowerNearTrack(builder, totalDistance * 0.18, trackWidth * 0.5 + 52, 1.08);
	addToyTowerNearTrack(builder, totalDistance * 0.72, -trackWidth * 0.5 - 56, 0.86);
	addToyTunnelPortal(builder, totalDistance * 0.36, trackWidth * 0.5 + 24, 1.12);
	addToyTunnelPortal(builder, totalDistance * 0.82, -trackWidth * 0.5 - 22, 0.94);
	addMaterialShowcase(builder, 11, trackWidth * 0.5 + 1.8, 0.95);
	addPremiumCornerMarker(builder, 31, trackWidth * 0.5 + 8.4, 1.22);
	addPremiumCornerMarker(builder, totalDistance * 0.11, -trackWidth * 0.5 - 10.5);
	addTracksideTireBarriers(builder);
  for (let i = 2; i <= 12; i++) {
		addArrowSign(builder, (totalDistance * i) / 14);
	}
  for (let d = 8; d < 118; d += 12) {
    addFenceSegment(builder, d, d + 9, -trackWidth * 0.5 - 7.5);
  }
  for (let d = 48; d < 148; d += 12) {
    addFenceSegment(builder, d, d + 9, trackWidth * 0.5 + 7.5);
  }
  for (const [distance, side, scale] of [
    [18, -1, 1.0],
    [24, 1, 0.88],
    [39, -1, 0.76],
    [52, 1, 1.12],
    [74, -1, 1.2],
    [95, 1, 0.9],
    [126, -1, 0.98],
    [154, 1, 1.18],
    [totalDistance * 0.25, -1, 1.1],
    [totalDistance * 0.31, 1, 0.92],
    [totalDistance * 0.48, -1, 1.06],
    [totalDistance * 0.58, 1, 0.9],
    [totalDistance * 0.68, -1, 1.16],
    [totalDistance * 0.77, 1, 0.96],
  ]) {
    addBushClusterAtTrack(builder, distance, side * (trackWidth * 0.5 + 9.5), scale);
  }
  for (const [distance, side, scale] of [
    [22, -1, 1.15],
    [36, 1, 0.92],
    [58, -1, 1.34],
    [82, 1, 1.08],
    [118, -1, 0.96],
    [146, 1, 1.26],
    [totalDistance * 0.2, 1, 1.18],
    [totalDistance * 0.28, -1, 1.0],
    [totalDistance * 0.46, 1, 1.24],
    [totalDistance * 0.63, -1, 1.08],
    [totalDistance * 0.79, 1, 1.16],
  ]) {
    const p = offsetTrackPoint(distance, side * (trackWidth * 0.5 + 22), 0);
    addTree(builder, p.x, p.z, scale);
  }
  for (let d = totalDistance * 0.25; d < totalDistance * 0.43; d += 12) {
    addFenceSegment(builder, d, d + 9, -trackWidth * 0.5 - 7.5);
  }
  for (let d = totalDistance * 0.68; d < totalDistance * 0.86; d += 12) {
    addFenceSegment(builder, d, d + 9, trackWidth * 0.5 + 7.5);
  }
  const rnd = random(0x51ce71c);
  let trees = 0;
  while (trees < 135) {
    const x = (rnd() - 0.5) * terrainWidth * 0.9;
    const z = (rnd() - 0.5) * terrainDepth * 0.9;
    const n = nearestRoad(x, z);
    if (n.distance < trackWidth * 0.5 + 20 || n.distance > 105) continue;
    addTree(builder, x, z, 0.7 + rnd() * 0.8);
    trees++;
  }
  let rocks = 0;
  while (rocks < 64) {
    const x = (rnd() - 0.5) * terrainWidth * 0.82;
    const z = (rnd() - 0.5) * terrainDepth * 0.82;
    const n = nearestRoad(x, z);
    if (n.distance < trackWidth * 0.5 + 12 || n.distance > 125) continue;
    addRock(builder, x, z, 0.65 + rnd() * 1.1);
    rocks++;
  }
  const primitives = [];
  for (const [material, arrays] of builder.entries()) {
    primitives.push(primitiveFromArrays(arrays.positions, arrays.normals, arrays.uvs, arrays.indices, material));
  }
  return encodeGlb({
    primitives,
    materials: SCENERY_MATERIALS,
    images: SCENERY_IMAGES,
    textures: SCENERY_TEXTURES,
  });
}

function makeCornerMarkerShowcaseGlb() {
  const builder = makeBuilder();
  addPremiumCornerMarkerAt(builder, { x: 0, y: 0, z: 0 }, 0, 1, 1);
  const primitives = [];
  for (const [material, arrays] of builder.entries()) {
    primitives.push(primitiveFromArrays(arrays.positions, arrays.normals, arrays.uvs, arrays.indices, material));
  }
  return encodeGlb({
    primitives,
    materials: SCENERY_MATERIALS,
    images: SCENERY_IMAGES,
    textures: SCENERY_TEXTURES,
  });
}

function makeMaterialShowcaseGlb() {
  const builder = makeBuilder();
  addMaterialShowcaseAt(builder, { x: 0, y: 0, z: 0 }, 0, 1, 1);
  const primitives = [];
  for (const [material, arrays] of builder.entries()) {
    primitives.push(primitiveFromArrays(arrays.positions, arrays.normals, arrays.uvs, arrays.indices, material));
  }
  return encodeGlb({
    primitives,
    materials: SCENERY_MATERIALS,
    images: SCENERY_IMAGES,
    textures: SCENERY_TEXTURES,
  });
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
    if (primitive.positions.length === 0 || primitive.indices.length === 0) continue;
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
      attributes: { POSITION: positionAccessor, NORMAL: normalAccessor, TEXCOORD_0: uvAccessor },
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
    const color = material.color ?? material;
    const pbr = {
      baseColorFactor: color,
      roughnessFactor: material.roughness ?? 0.78,
      metallicFactor: material.metallic ?? 0,
    };
    if (material.texture !== undefined) {
      pbr.baseColorTexture = { index: material.texture };
    }
    if (material.mrTexture !== undefined) {
      pbr.metallicRoughnessTexture = { index: material.mrTexture };
    }
    const out = { pbrMetallicRoughness: pbr };
    if (material.normalTexture !== undefined) {
      out.normalTexture = { index: material.normalTexture, scale: 0.8 };
    }
    if (material.emissive) {
      out.emissiveFactor = material.emissive;
    }
    return out;
  });
  const json = {
    asset: { version: '2.0', generator: 'MarbleRush scenic track generator' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: primitiveDefs }],
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

const roadTexture = makeRoadTexture();
const roadNormal = makeRoadNormalTexture();
writeFileSync(join(outDir, 'heightmap.png'), makeHeightmap());
writeFileSync(join(outDir, 'grass_texture.png'), makeGrassTexture());
writeFileSync(join(outDir, 'grass_normal.png'), makeGrassNormalTexture());
writeFileSync(join(outDir, 'grass_mr.png'), makeGrassMetallicRoughnessTexture());
writeFileSync(join(outDir, 'meadow_texture.png'), makeMeadowTexture());
writeFileSync(join(outDir, 'meadow_normal.png'), makeMeadowNormalTexture());
writeFileSync(join(outDir, 'meadow_mr.png'), makeMeadowMetallicRoughnessTexture());
writeFileSync(join(outDir, 'dirt_texture.png'), makeDirtTexture());
writeFileSync(join(outDir, 'dirt_normal.png'), makeDirtNormalTexture());
writeFileSync(join(outDir, 'dirt_mr.png'), makeDirtMetallicRoughnessTexture());
writeFileSync(join(outDir, 'rock_texture.png'), makeRockTexture());
writeFileSync(join(outDir, 'rock_normal.png'), makeRockNormalTexture());
writeFileSync(join(outDir, 'rock_mr.png'), makeRockMetallicRoughnessTexture());
writeFileSync(join(outDir, 'terrain_splat.png'), makeTerrainSplatControl());
writeFileSync(join(outDir, 'road_texture.png'), roadTexture);
writeFileSync(join(outDir, 'road_normal.png'), roadNormal);
writeFileSync(join(outDir, 'road.glb'), makeRoadGlb(roadTexture, roadNormal));
writeFileSync(join(outDir, 'road_collision.glb'), makeCollisionGlb());
writeFileSync(join(outDir, 'scenic_props.glb'), makeSceneryGlb());
writeFileSync(join(modelOutDir, 'corner_marker_showcase.glb'), makeCornerMarkerShowcaseGlb());
writeFileSync(join(modelOutDir, 'material_showcase.glb'), makeMaterialShowcaseGlb());
writeFileSync(join(outDir, 'map.json'), `${JSON.stringify(makeMapJson(), null, 2)}\n`);
writeFileSync(join(outDir, 'track.json'), `${JSON.stringify(makeTrackJson(), null, 2)}\n`);
console.log(`generated scenic track: ${outDir}`);
console.log(`track length: ${totalDistance.toFixed(1)}m`);
