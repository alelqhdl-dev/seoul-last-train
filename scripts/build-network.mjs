// OSM 캐시 → public/data/network.json
// 역 병합, 노선 선형 연결, 역 투영, 구간(segment) 분할까지 처리합니다.
import fs from 'node:fs';
import { RELATIONS_META, LINES } from './lib/config.mjs';
import { romanize } from './lib/romanize.mjs';

const raw = JSON.parse(fs.readFileSync('scripts/.cache/osm-raw.json', 'utf8'));
const stRaw = fs.existsSync('scripts/.cache/osm-stations.json')
  ? JSON.parse(fs.readFileSync('scripts/.cache/osm-stations.json', 'utf8')).elements
  : [];
const nodes = new Map(raw.elements.filter((e) => e.type === 'node').map((e) => [e.id, e]));
const rels = new Map(raw.elements.filter((e) => e.type === 'relation').map((e) => [e.id, e]));

// ---------- 기하 유틸 ----------
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
function dist(a, b) {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const x = dLon * Math.cos(rad((a[1] + b[1]) / 2));
  return Math.sqrt(x * x + dLat * dLat) * R;
}
function cumulative(path) {
  const c = [0];
  for (let i = 1; i < path.length; i++) c.push(c[i - 1] + dist(path[i - 1], path[i]));
  return c;
}
// 점 p를 선분 ab에 투영 (평면 근사)
function projSeg(p, a, b) {
  const kx = Math.cos(rad(p[1]));
  const ax = a[0] * kx, ay = a[1], bx = b[0] * kx, by = b[1], px = p[0] * kx, py = p[1];
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { t, q, d: dist(p, q) };
}
function simplify(pts, tol = 4) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let md = 0, mi = -1;
    for (let i = s + 1; i < e; i++) {
      const d = projSeg(pts[i], pts[s], pts[e]).d;
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; stack.push([s, mi], [mi, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// ---------- 역 이름 정규화 ----------
const ALIAS = { 총신대입구: '이수' };
const DISPLAY = { 이수: '총신대입구(이수)' };
function baseName(n) {
  let s = (n || '').replace(/\(.*?\)/g, '').replace(/\s+/g, '').trim();
  if (s !== '서울역' && s.endsWith('역') && s.length > 2) s = s.slice(0, -1);
  return s;
}
function keyOf(n) {
  const b = baseName(n);
  return ALIAS[b] || b;
}
function cleanEn(e) {
  if (!e) return null;
  let s = e.replace(/\s*\((?:il|i|sam|sa|o|yuk|chil)\)-ga/gi, '-ga');
  s = s.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s*Station\b.*$/i, '').replace(/\s+/g, ' ').trim();
  if (!s || /Line$/i.test(s)) return null;
  return s;
}

// OSM 역 노드 인덱스 (영문명/좌표 보강용)
const stIndex = new Map();
for (const s of stRaw) {
  const k = keyOf(s.tags?.name);
  if (!k) continue;
  if (!stIndex.has(k)) stIndex.set(k, []);
  stIndex.get(k).push(s);
}

// ---------- 선형 연결 ----------
function chainWays(rel) {
  const ways = rel.members.filter((m) => m.type === 'way' && m.geometry && !/platform/.test(m.role));
  const geoms = ways.map((w) => w.geometry.map((g) => [g.lon, g.lat]));
  if (!geoms.length) return [];
  let line = geoms[0].slice();
  if (geoms.length > 1) {
    const g1 = geoms[1];
    const dEnd = Math.min(dist(line.at(-1), g1[0]), dist(line.at(-1), g1.at(-1)));
    const dStart = Math.min(dist(line[0], g1[0]), dist(line[0], g1.at(-1)));
    if (dStart < dEnd) line.reverse();
  }
  for (let i = 1; i < geoms.length; i++) {
    const g = geoms[i];
    const end = line.at(-1);
    if (dist(end, g[0]) <= dist(end, g.at(-1))) line.push(...g.slice(dist(end, g[0]) < 1 ? 1 : 0));
    else {
      const r = g.slice().reverse();
      line.push(...r.slice(dist(end, r[0]) < 1 ? 1 : 0));
    }
  }
  return line;
}

// stop 노드 목록
function stopsOf(rel) {
  return rel.members
    .filter((m) => m.type === 'node' && /^stop/.test(m.role))
    .map((m) => nodes.get(m.ref))
    .filter(Boolean)
    .map((n) => ({ name: n.tags?.name, en: n.tags?.['name:en'], pos: [n.lon, n.lat] }));
}

// ---------- 역 레지스트리 ----------
const stations = new Map(); // key -> {key, names:Set, ens:[], stopPos:[], lines:Set}
function regStation(stop, line) {
  const k = keyOf(stop.name);
  if (!stations.has(k)) stations.set(k, { key: k, names: [], ens: [], stopPos: [], lines: new Set() });
  const s = stations.get(k);
  s.names.push(stop.name);
  if (stop.en) s.ens.push(stop.en);
  s.stopPos.push(stop.pos);
  s.lines.add(line);
  return k;
}

// ---------- 지선 처리 ----------
const branchesRaw = [];
for (const meta of RELATIONS_META) {
  const rel = rels.get(meta.rel);
  if (!rel) { console.warn('missing relation', meta.id); continue; }
  let stops = stopsOf(rel);
  const path = chainWays(rel);
  if (meta.cutAfter) {
    const i = stops.findIndex((s) => keyOf(s.name) === meta.cutAfter);
    if (i >= 0) stops = stops.slice(0, i + 1);
  }
  branchesRaw.push({ ...meta, stops, path });
}

// 같은 노선의 앞선 지선과 겹치는 앞부분 제거 → 이어지면 병합
const branches = [];
for (const b of branchesRaw) {
  const prev = branches.filter((x) => x.line === b.line);
  const seen = new Set(prev.flatMap((x) => x.stops.map((s) => keyOf(s.name))));
  let k = 0;
  while (k < b.stops.length - 1 && seen.has(keyOf(b.stops[k + 1].name)) && seen.has(keyOf(b.stops[k].name))) k++;
  if (k > 0) b.stops = b.stops.slice(k);
  const head = keyOf(b.stops[0].name);
  const joinTo = prev.find((x) => !x.loop && keyOf(x.stops.at(-1).name) === head);
  if (joinTo && prev.length) {
    joinTo.parts.push({ stops: b.stops, path: b.path });
    joinTo.stops = joinTo.stops.concat(b.stops.slice(1));
    joinTo.ko = joinTo.ko + '·' + b.ko;
    continue;
  }
  branches.push({ ...b, parts: [{ stops: b.stops, path: b.path }] });
}

// ---------- 투영 & 구간 생성 ----------
function buildSegments(stops, path) {
  // stops를 path에 단조 증가로 투영
  const cum = cumulative(path);
  const ms = [];
  let from = 0;
  for (const s of stops) {
    let best = { d: Infinity, m: cum[from], q: s.pos, i: from };
    for (let i = from; i < path.length - 1; i++) {
      const pr = projSeg(s.pos, path[i], path[i + 1]);
      if (pr.d < best.d - 0.01) best = { d: pr.d, m: cum[i] + pr.t * (cum[i + 1] - cum[i]), q: pr.q, i };
      // 충분히 가까운 점을 찾은 뒤 멀어지면 중단 (루프/왕복 선형 대비)
      if (best.d < 60 && pr.d > best.d + 1500) break;
    }
    ms.push(best);
    from = best.i;
  }
  const segs = [];
  for (let k = 0; k < stops.length - 1; k++) {
    const a = ms[k], b = ms[k + 1];
    const straight = dist(stops[k].pos, stops[k + 1].pos);
    let pts;
    const ok = a.d < 400 && b.d < 400 && b.m > a.m && b.m - a.m < straight * 3 + 300;
    if (ok) {
      pts = [a.q];
      for (let i = a.i + 1; i <= b.i; i++) pts.push(path[i]);
      pts.push(b.q);
    } else {
      pts = [stops[k].pos, stops[k + 1].pos];
    }
    pts = simplify(pts, 4);
    segs.push({ pts, ok, len: ok ? b.m - a.m : straight });
  }
  return segs;
}

const outBranches = [];
let fallbackSegs = 0;
for (const b of branches) {
  const stopKeys = b.stops.map((s) => regStation(s, b.line));
  let segs = [];
  for (const part of b.parts) {
    const s = buildSegments(part.stops, part.path);
    segs = segs.concat(s);
  }
  fallbackSegs += segs.filter((s) => !s.ok).length;
  outBranches.push({ id: b.id, line: b.line, ko: b.ko, loop: !!b.loop, stopKeys, segs });
}

// ---------- 역 최종 정보 ----------
const stationList = [...stations.values()];
const keyToIdx = new Map(stationList.map((s, i) => [s.key, i]));
const round = (v) => Math.round(v * 1e6) / 1e6;
const outStations = stationList.map((s) => {
  const avg = (arr) => [arr.reduce((a, p) => a + p[0], 0) / arr.length, arr.reduce((a, p) => a + p[1], 0) / arr.length];
  const center = avg(s.stopPos);
  const cands = (stIndex.get(s.key) || []).filter((n) => dist([n.lon, n.lat], center) < 1500);
  const pos = cands.length ? avg(cands.map((n) => [n.lon, n.lat])) : center;
  const en =
    (s.key === '서울역' && 'Seoul Station') ||
    cleanEn(cands.find((n) => n.tags?.['name:en'])?.tags['name:en']) ||
    cleanEn(s.ens[0]) ||
    romanize(s.key);
  const ko = DISPLAY[s.key] || s.key;
  return { ko, en, pos: [round(pos[0]), round(pos[1])], lines: [...s.lines].sort() };
});

const network = {
  generatedAt: new Date().toISOString(),
  lines: LINES,
  stations: outStations,
  branches: outBranches.map((b) => ({
    id: b.id,
    line: b.line,
    ko: b.ko,
    loop: b.loop,
    stops: b.stopKeys.map((k) => keyToIdx.get(k)),
    segs: b.segs.map((s) => ({ len: Math.round(s.len), pts: s.pts.map((p) => [round(p[0]), round(p[1])]) })),
  })),
};
fs.mkdirSync('public/data', { recursive: true });
fs.writeFileSync('public/data/network.json', JSON.stringify(network));
console.log(`stations ${outStations.length}, branches ${outBranches.length}, fallback segs ${fallbackSegs}`);
for (const b of network.branches) {
  const names = b.stops.map((i) => outStations[i].ko);
  console.log(`${b.id} (${b.ko}) ${names.length}역: ${names[0]} → ${names.at(-1)}  총 ${(b.segs.reduce((a, s) => a + s.len, 0) / 1000).toFixed(1)}km`);
}
const noEn = outStations.filter((s) => !stIndex.has(s.ko)).length;
console.log('stations without OSM station-node match:', noEn);
