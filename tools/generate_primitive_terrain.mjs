import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'assets', 'maps', 'primitive_track');
mkdirSync(outDir, { recursive: true });

const mapScale = 2.45;
const landmarkScale = 1.42;
const terrainWidth = 360 * mapScale;
const terrainDepth = 360 * mapScale;
const terrainY = -2.6;
const terrainHeight = 12.0;
const heightmapSize = 257;
const splatSize = 1024;
const trackWidth = 17.5;
const trackClearance = 0.18;
const shoulderWidth = 9.5;
const terrainBlendWidth = 34;
const samples = 256;
const trackPointCount = 24;

function baseTrackPoint(i) {
  const t = i / trackPointCount;
  const a = t * Math.PI * 2;
  const rx = mapScale * (86 + 12 * Math.sin(a * 3 + 0.35));
  const rz = mapScale * (66 + 9 * Math.cos(a * 2 - 0.2));
  return {
    x: Math.sin(a) * rx,
    y: 0.45 * Math.sin(a * 2 + 0.4),
    z: Math.cos(a) * rz,
  };
}

function straightenSpawnRun(points) {
  const entry = points[10];
  const anchor = points[11];
  const dx = anchor.x - entry.x;
  const dz = anchor.z - entry.z;
  const len = Math.max(0.0001, Math.hypot(dx, dz));
  points[12] = {
    x: anchor.x + (dx / len) * 62,
    y: anchor.y,
    z: anchor.z + (dz / len) * 62,
  };
}

const trackPoints = Array.from({ length: trackPointCount }, (_, i) => baseTrackPoint(i));
straightenSpawnRun(trackPoints);
const trackSegments = trackPoints.map((point, i) => {
  const next = trackPoints[(i + 1) % trackPoints.length];
  return Math.hypot(next.x - point.x, next.z - point.z);
});
const trackLength = trackSegments.reduce((sum, length) => sum + length, 0);

function sampleTrack(distance) {
  let d = ((distance % trackLength) + trackLength) % trackLength;
  for (let i = 0; i < trackPoints.length; i++) {
    const segLen = trackSegments[i];
    if (d > segLen) {
      d -= segLen;
      continue;
    }
    const point = trackPoints[i];
    const next = trackPoints[(i + 1) % trackPoints.length];
    const t = segLen > 0 ? d / segLen : 0;
    return {
      x: mix(point.x, next.x, t),
      y: mix(point.y, next.y, t),
      z: mix(point.z, next.z, t),
    };
  }
  return trackPoints[0];
}

function centerAt(t) {
  const u = ((t / (Math.PI * 2)) % 1 + 1) % 1;
  return sampleTrack(u * trackLength);
}

const centerline = Array.from({ length: samples }, (_, i) => centerAt((i / samples) * Math.PI * 2));

function nearestRoad(x, z) {
  let best = centerline[0];
  let bestD = Infinity;
  for (const point of centerline) {
    const d = Math.hypot(x - point.x, z - point.z);
    if (d < bestD) {
      best = point;
      bestD = d;
    }
  }
  return { point: best, distance: bestD };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function mix(a, b, t) {
  return a * (1 - t) + b * t;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function noise2(x, y) {
  let n = (x * 374761393 + y * 668265263) >>> 0;
  n = ((n ^ (n >>> 13)) * 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) & 255) / 255;
}

function terrainWorldY(x, z) {
  const nearest = nearestRoad(x, z);
  const halfTrack = trackWidth * 0.5;
  const shoulderT = smoothstep(halfTrack, halfTrack + shoulderWidth, nearest.distance);
  const roadBench = nearest.point.y - trackClearance - shoulderT * 0.48;
  const broadHill =
    -0.55 +
    1.15 * Math.sin((x + 54 * mapScale) / (57 * mapScale)) * Math.cos((z - 12 * mapScale) / (63 * mapScale)) +
    0.42 * Math.sin((x - z) / (37 * mapScale)) +
    0.28 * Math.cos((x + z) / (44 * mapScale));
  const lakeX = 44 * mapScale;
  const lakeZ = 8 * mapScale;
  const lakeRadius = 46 * landmarkScale;
  const lakeBasin = -1.0 * Math.exp(-((x - lakeX) * (x - lakeX) + (z - lakeZ) * (z - lakeZ)) / (2 * lakeRadius * lakeRadius));
  const backRidge = 1.75 * smoothstep(90 * mapScale, 180 * mapScale, Math.abs(z + 138 * mapScale));
  const sideRidge = 1.1 * smoothstep(112 * mapScale, 178 * mapScale, Math.abs(x));
  const scenic = broadHill + lakeBasin + backRidge + sideRidge;
  const blend = smoothstep(halfTrack + shoulderWidth, halfTrack + shoulderWidth + terrainBlendWidth, nearest.distance);
  return mix(roadBench, scenic, blend);
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

function makeTerrainSplat() {
  const pixels = Buffer.alloc(splatSize * splatSize * 4);
  for (let row = 0; row < splatSize; row++) {
    const z = (row / (splatSize - 1) - 0.5) * terrainDepth;
    for (let col = 0; col < splatSize; col++) {
      const x = (col / (splatSize - 1) - 0.5) * terrainWidth;
      const nearest = nearestRoad(x, z);
      const y = terrainWorldY(x, z);
      const halfTrack = trackWidth * 0.5;
      const roadWear = 1 - smoothstep(halfTrack + 0.5, halfTrack + shoulderWidth + 12.0, nearest.distance);
      const highRock = smoothstep(1.25, 3.2, y) * (0.56 + noise2(col + 31, row - 47) * 0.44);
      const dirt = roadWear * (0.58 + noise2(col - 19, row + 7) * 0.28);
      const meadow = smoothstep(0.68, 0.94, noise2(Math.floor(col / 4) + 71, Math.floor(row / 4) - 23)) * (1 - roadWear * 0.38) * (1 - highRock * 0.7);
      const dampGrass = smoothstep(0.0, 1.0, 0.7 - y) * 0.18;
      let grass = Math.max(0.42, 0.98 - dirt * 0.74 - highRock * 0.88 - meadow * 0.34 + dampGrass);
      let rock = highRock * 1.08;
      let mud = dirt + dampGrass * 0.52;
      let flowers = meadow * 0.46;
      const sum = Math.max(0.0001, grass + flowers + mud + rock);
      const i = (row * splatSize + col) * 4;
      pixels[i] = Math.round((grass / sum) * 255);
      pixels[i + 1] = Math.round((flowers / sum) * 255);
      pixels[i + 2] = Math.round((mud / sum) * 255);
      pixels[i + 3] = Math.round((rock / sum) * 255);
    }
  }
  return encodePngRgba(splatSize, splatSize, pixels);
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
    const rowStart = row * (width * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, row * width * 4, (row + 1) * width * 4);
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
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

writeFileSync(join(outDir, 'heightmap_large.png'), makeHeightmap());
writeFileSync(join(outDir, 'terrain_splat_large.png'), makeTerrainSplat());
