import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { LineLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import './style.css';
import { loadData, fmt, pointOnSeg, T_MIN, T_MAX } from './data.js';

// ---------------- 상태 ----------------
const state = {
  t: 23 * 60 + 30,
  day: 'weekday',
  height: 'time',
  playing: false,
  selected: null, // station idx
  focusLine: null, // line id
  userPos: null, // [lon, lat]
};
const $ = (id) => document.getElementById(id);
const isMobile = () => window.innerWidth <= 768;

// PWA 서비스워커 등록
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

function distMeters(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const x = dLon * Math.cos(rad((a[1] + b[1]) / 2));
  return Math.sqrt(x * x + dLat * dLat) * 6371008.8;
}
function fmtDist(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`;
}

let toastTimer = null;
function showToast(msg, ms = 3200) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

const D = await loadData();
const { stations, segments, branches, lines, lineById, tt } = D;
$('stat-stations').textContent = stations.length;
$('stat-lines').textContent = lines.length;
if (tt.source === 'mock') {
  $('data-badge').hidden = false;
  $('data-badge').textContent = '⚠ 임시(가상) 시간표 · API 키 연결 전';
  $('info-source').textContent = '현재 시간표는 화면 개발용 가상 데이터입니다. 실제 데이터는 서울 열린데이터광장 API로 수집합니다.';
} else {
  $('info-source').textContent = `시간표: ${tt.sourceLabel || '서울 열린데이터광장'} (수집 ${tt.generatedAt?.slice(0, 10)})`;
}

// 종착역 & 주요 거점역 (라벨 우선순위용)
const terminalSet = new Set();
for (const b of branches) { terminalSet.add(b.stops[0]); terminalSet.add(b.stops.at(-1)); }
const MAJOR_NAMES = new Set([
  '서울역', '시청', '강남', '잠실', '홍대입구', '여의도', '신도림', '고속터미널', '사당',
  '왕십리', '청량리', '노원', '영등포', '종로3가', '동대문역사문화공원', '건대입구', '공덕',
  '삼각지', '천호', '연신내', '구로', '부평', '인천', '수원', '의정부', '대화', '오이도',
  '김포공항', '하남검단산', '진접', '모란', '중앙보훈병원', '광명', '석남', '별내',
]);
const labelCandidates = stations
  .filter((s) => s.lines.length > 1 || terminalSet.has(s.idx) || MAJOR_NAMES.has(s.ko))
  .map((s) => ({
    st: s,
    prio: (MAJOR_NAMES.has(s.ko) ? 30 : 0) + s.lines.length * 8 + (terminalSet.has(s.idx) ? 10 : 0),
  }))
  .sort((a, b) => b.prio - a.prio);

const labelsRoot = $('map-labels');
const labelDomMap = new Map();
function ensureLabelEl(st) {
  let el = labelDomMap.get(st.idx);
  if (!el) {
    el = document.createElement('div');
    el.className = 'st-label';
    el.innerHTML = `<span class="ko">${st.ko}</span><span class="en">${st.en}</span>`;
    el.hidden = true;
    labelsRoot.appendChild(el);
    labelDomMap.set(st.idx, el);
  }
  return el;
}

// ---------------- 지도 ----------------
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json',
  center: [126.985, 37.535],
  zoom: isMobile() ? 9.6 : 10.1,
  pitch: isMobile() ? 45 : 52,
  bearing: -8,
  maxPitch: 75,
  antialias: true,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
const overlay = new MapboxOverlay({
  interleaved: false,
  layers: [],
  onAfterRender: () => updateLabels(),
});
map.addControl(overlay);
map.on('move', () => updateLabels());
map.on('resize', () => render());
map.on('load', () => {
  // 바탕 지도를 더 어둡게
  for (const layer of map.getStyle().layers) {
    if (layer.type === 'background') map.setPaintProperty(layer.id, 'background-color', '#0a0c14');
  }
});

// ---------------- 높이 계산 ----------------
const H_TIME = 5200; // m
const H_LINE = 520; // 노선 한 층의 높이
function zForStation(si, lineId) {
  if (state.height === 'flat') return 0;
  if (state.height === 'line') return (lineById.get(lineId).idx + 1) * H_LINE;
  const end = stations[si].end[state.day];
  if (end == null) return 0;
  const u = Math.max(0, Math.min(1, (end - (23 * 60)) / (25 * 60 + 40 - 23 * 60)));
  return 150 + u * H_TIME;
}

let geomCache = null;
function buildGeometry() {
  // 세그먼트 3D 경로
  for (const s of segments) {
    const za = zForStation(s.a, s.line.id);
    const zb = zForStation(s.b, s.line.id);
    s.za = za; s.zb = zb;
    s.path3d = s.pts.map((p, i) => [p[0], p[1], za + (zb - za) * s.frac[i]]);
  }
  // 역 노드: 노선별 모드에서는 노선마다 하나씩
  const nodes = [];
  for (const st of stations) {
    if (state.height === 'line') for (const l of st.lines) nodes.push({ st, line: lineById.get(l), z: zForStation(st.idx, l) });
    else nodes.push({ st, line: lineById.get(st.lines[0]), z: zForStation(st.idx, st.lines[0]) });
  }
  const labelZ = new Map();
  for (const n of nodes) labelZ.set(n.st.idx, Math.max(labelZ.get(n.st.idx) ?? 0, n.z));
  geomCache = { nodes, labelZ, key: state.height + state.day };
}

// ---------------- 시간 의존 계산 ----------------
function segAlive(s, t) {
  const d = tt.days[state.day]?.[s.branch.id];
  if (!d) return false;
  const f = d.fwd?.[s.k + 1] ?? -1;
  const r = d.rev?.[s.k] ?? -1;
  return t < Math.max(f, r);
}
function stationState(st, t) {
  const end = st.end[state.day];
  const dep = st.lastDep[state.day];
  if (end == null || t >= end) return 'off';
  if (dep != null && dep - t <= 10 && dep - t >= 0) return 'soon';
  return 'on';
}
function trainsAt(t) {
  const out = [];
  const Dd = tt.days[state.day] || {};
  for (const b of branches) {
    const d = Dd[b.id];
    if (!d) continue;
    const n = b.stops.length;
    for (const dir of ['fwd', 'rev']) {
      const arr = d[dir];
      if (!arr) continue;
      for (let k = 0; k < n - 1; k++) {
        const ta = dir === 'fwd' ? arr[k] : arr[k + 1];
        const tb = dir === 'fwd' ? arr[k + 1] : arr[k];
        if (ta == null || tb == null || !(tb > ta) || tb - ta > 25) continue;
        if (t >= ta && t < tb) {
          const s = b.segList[k];
          const u = (t - ta) / (tb - ta);
          const f = dir === 'fwd' ? u : 1 - u;
          const p = pointOnSeg(s, f);
          const z = s.za + (s.zb - s.za) * f;
          const nextIdx = dir === 'fwd' ? s.b : s.a;
          const destArr = d[dir + 'Dest'];
          out.push({
            pos: [p[0], p[1], z + 30],
            line: b.lineObj,
            branch: b,
            dir,
            dest: destArr?.[dir === 'fwd' ? k : k + 1] || (dir === 'fwd' ? b.towardFwd : b.towardRev),
            next: stations[nextIdx],
            nextT: tb,
          });
        }
      }
    }
  }
  return out;
}

// ---------------- 레이어 ----------------
const DEAD = [58, 62, 82];
const SOON = [255, 140, 70];
function dimFor(lineId) {
  return state.focusLine && state.focusLine !== lineId ? 0.12 : 1;
}

function render() {
  if (!geomCache || geomCache.key !== state.height + state.day) buildGeometry();
  const t = state.t;
  const tKey = Math.round(t * 2) / 2;
  const trig = [tKey, state.day, state.height, state.focusLine, state.selected];
  const { nodes, labelZ } = geomCache;
  const trains = trainsAt(t);

  const layers = [
    new LineLayer({
      id: 'stems',
      data: state.height === 'flat' ? [] : nodes,
      getSourcePosition: (n) => [n.st.pos[0], n.st.pos[1], 0],
      getTargetPosition: (n) => [n.st.pos[0], n.st.pos[1], n.z],
      getColor: (n) => {
        const s = stationState(n.st, tKey);
        const a = dimFor(state.focusLine && n.st.lines.includes(state.focusLine) ? state.focusLine : n.line.id);
        return s === 'off' ? [...DEAD, 35 * a] : [...n.line.rgb, 50 * a];
      },
      getWidth: 1,
      widthUnits: 'pixels',
      parameters: { depthTest: false },
      updateTriggers: { getColor: trig, getTargetPosition: trig },
    }),
    new PathLayer({
      id: 'seg-glow',
      data: segments,
      getPath: (s) => s.path3d,
      getColor: (s) => (segAlive(s, tKey) ? [...s.line.rgb, 55 * dimFor(s.line.id)] : [0, 0, 0, 0]),
      getWidth: 9,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
      parameters: { depthTest: false },
      updateTriggers: { getColor: trig, getPath: trig },
    }),
    new PathLayer({
      id: 'seg',
      data: segments,
      getPath: (s) => s.path3d,
      getColor: (s) => {
        const a = dimFor(s.line.id);
        return segAlive(s, tKey) ? [...s.line.rgb, 240 * a] : [...DEAD, 150 * a];
      },
      getWidth: (s) => (segAlive(s, tKey) ? 2.6 : 1.4),
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
      parameters: { depthTest: false },
      pickable: true,
      autoHighlight: false,
      updateTriggers: { getColor: trig, getWidth: trig, getPath: trig },
      onHover: onHoverSeg,
    }),
    new ScatterplotLayer({
      id: 'station-glow',
      data: nodes,
      getPosition: (n) => [n.st.pos[0], n.st.pos[1], n.z],
      getRadius: (n) => {
        const s = stationState(n.st, tKey);
        return s === 'off' ? 6 : n.st.idx === state.selected ? 18 : 11;
      },
      getFillColor: (n) => {
        const s = stationState(n.st, tKey);
        const a = dimFor(state.focusLine && n.st.lines.includes(state.focusLine) ? state.focusLine : n.line.id);
        if (s === 'off') return [0, 0, 0, 1];
        const c = s === 'soon' ? SOON : n.line.rgb;
        return [...c, (n.st.idx === state.selected ? 140 : 80) * a];
      },
      radiusUnits: 'pixels',
      pickable: true,
      parameters: { depthTest: false },
      updateTriggers: { getFillColor: trig, getRadius: trig, getPosition: trig },
      onHover: onHoverStation,
      onClick: (info) => info.object && selectStation(info.object.st.idx, false),
    }),
    new ScatterplotLayer({
      id: 'station',
      data: nodes,
      getPosition: (n) => [n.st.pos[0], n.st.pos[1], n.z],
      getRadius: (n) => {
        const s = stationState(n.st, tKey);
        const big = n.st.lines.length > 1 ? 1.2 : 0;
        return s === 'off' ? 2.4 : 3.6 + big;
      },
      getFillColor: (n) => {
        const s = stationState(n.st, tKey);
        const a = dimFor(state.focusLine && n.st.lines.includes(state.focusLine) ? state.focusLine : n.line.id);
        if (s === 'off') return [...DEAD, 220 * a];
        const c = s === 'soon' ? SOON : n.line.rgb;
        return [Math.round(c[0] * 0.35 + 255 * 0.65), Math.round(c[1] * 0.35 + 255 * 0.65), Math.round(c[2] * 0.35 + 255 * 0.65), 255 * a];
      },
      stroked: true,
      getLineColor: (n) => (n.st.idx === state.selected ? [255, 255, 255, 255] : [0, 0, 0, 0]),
      lineWidthUnits: 'pixels',
      getLineWidth: 1.5,
      radiusUnits: 'pixels',
      parameters: { depthTest: false },
      updateTriggers: { getFillColor: trig, getRadius: trig, getPosition: trig, getLineColor: trig },
    }),
    new ScatterplotLayer({
      id: 'train-glow',
      data: trains,
      getPosition: (d) => d.pos,
      getRadius: 16,
      radiusUnits: 'pixels',
      getFillColor: (d) => [...d.line.rgb, 110 * dimFor(d.line.id)],
      parameters: { depthTest: false },
      pickable: true,
      onHover: onHoverTrain,
    }),
    new ScatterplotLayer({
      id: 'train',
      data: trains,
      getPosition: (d) => d.pos,
      getRadius: 5,
      radiusUnits: 'pixels',
      getFillColor: [255, 255, 255, 255],
      stroked: true,
      getLineColor: (d) => [...d.line.rgb, 255],
      getLineWidth: 2.5,
      lineWidthUnits: 'pixels',
      parameters: { depthTest: false },
    }),
    new ScatterplotLayer({
      id: 'user-pos-glow',
      data: state.userPos ? [state.userPos] : [],
      getPosition: (p) => [p[0], p[1], 10],
      getRadius: 18,
      radiusUnits: 'pixels',
      getFillColor: [59, 158, 255, 75],
      parameters: { depthTest: false },
    }),
    new ScatterplotLayer({
      id: 'user-pos',
      data: state.userPos ? [state.userPos] : [],
      getPosition: (p) => [p[0], p[1], 15],
      getRadius: 6,
      radiusUnits: 'pixels',
      getFillColor: [59, 158, 255, 255],
      stroked: true,
      getLineColor: [255, 255, 255, 255],
      getLineWidth: 2.5,
      lineWidthUnits: 'pixels',
      parameters: { depthTest: false },
    }),
  ];
  overlay.setProps({ layers });
  updateLabels();

  // 시계 & 카운터
  $('clock').textContent = fmt(t);
  let on = 0, off = 0;
  for (const st of stations) (stationState(st, t) === 'off' ? off++ : on++);
  $('clock-sub').textContent = isMobile()
    ? `운행 ${on}역 · 종료 ${off}역 · 막차 ${trains.length}`
    : `막차 전 ${on}역 · 종료 ${off}역 · 운행 중 막차 ${trains.length}대`;
  const slider = $('slider');
  slider.value = t;
  slider.style.setProperty('--p', `${((t - T_MIN) / (T_MAX - T_MIN)) * 100}%`);
  if (state.selected != null) renderPopup();
}

// ---------------- 3D 투영 역 라벨 (충돌 방지) ----------------
function updateLabels() {
  if (!geomCache) return;
  const { labelZ } = geomCache;
  let vp = null;
  try {
    vp = overlay._deck?.getViewports?.()?.[0] || null;
  } catch {
    vp = null;
  }
  const w = window.innerWidth;
  const h = window.innerHeight;
  const tKey = Math.round(state.t * 2) / 2;

  // 선택된 역을 최우선으로 배치
  const list = [];
  if (state.selected != null) list.push({ st: stations[state.selected], selected: true });
  for (const c of labelCandidates) {
    if (c.st.idx === state.selected) continue;
    if (state.focusLine && !c.st.lines.includes(state.focusLine)) continue;
    list.push({ st: c.st, selected: false });
  }

  const placed = [];
  const visibleIds = new Set();
  for (const item of list) {
    const st = item.st;
    const z = labelZ.get(st.idx) ?? 0;
    let x, y;
    if (vp) {
      const p = vp.project([st.pos[0], st.pos[1], z]);
      x = p[0]; y = p[1];
    } else {
      const p = map.project(st.pos);
      x = p.x; y = p.y;
    }
    const mob = isMobile();
    const topLim = mob ? 148 : 85;
    const botLim = mob ? (state.selected != null ? h * 0.56 : 145) : 115;
    if (!isFinite(x) || !isFinite(y) || x < 36 || x > w - 36 || y < topLim || y > h - botLim) continue;
    // 데스크톱 상단 헤더·검색·우상단 컨트롤 아래로 겹치는 라벨 숨김
    if (!mob && !item.selected && ((x < 340 && y < 145) || (x > w - 430 && y < 115))) continue;

    // 예상 박스 크기로 겹침 검사
    const bw = Math.max(st.ko.length * 11, st.en.length * 5.2) + 22;
    const bh = 34;
    const box = { l: x - bw / 2, r: x + bw / 2, t: y - bh - 10, b: y - 4 };
    if (!item.selected && placed.some((p) => !(box.r < p.l || box.l > p.r || box.b < p.t || box.t > p.b))) {
      continue;
    }
    placed.push(box);
    visibleIds.add(st.idx);
    const el = ensureLabelEl(st);
    el.hidden = false;
    el.style.left = `${x.toFixed(1)}px`;
    el.style.top = `${y.toFixed(1)}px`;
    el.classList.toggle('off', stationState(st, tKey) === 'off');
    el.classList.toggle('selected', item.selected);
  }
  for (const [idx, el] of labelDomMap) {
    if (!visibleIds.has(idx)) el.hidden = true;
  }
}

// ---------------- 툴팁 ----------------
const tip = $('hover-tip');
function showTip(info, html) {
  if (!info.object) { tip.hidden = true; return; }
  tip.innerHTML = html;
  tip.style.left = info.x + 'px';
  tip.style.top = info.y + 'px';
  tip.hidden = false;
}
const badge = (l) => `<span class="line-badge" style="background:${l.color}">${l.id}</span>`;
function onHoverStation(info) {
  if (!info.object) return showTip(info);
  const st = info.object.st;
  const dep = st.lastDep[state.day];
  showTip(info, `<div class="row">${st.lines.map((l) => badge(lineById.get(l))).join('')} <b>${st.ko}</b> <small>${st.en}</small></div>
    <small>가장 늦은 막차 ${fmt(dep)}</small>`);
}
function onHoverTrain(info) {
  if (!info.object) return showTip(info);
  const d = info.object;
  showTip(info, `<div class="row">${badge(d.line)} <b>막차 · ${d.dest}행</b></div>
    <small>다음 역 ${d.next.ko} ${fmt(d.nextT)} 도착</small>`);
}
function onHoverSeg(info) {
  if (!info.object) return showTip(info);
  const s = info.object;
  showTip(info, `<div class="row">${badge(s.line)} <b>${s.line.ko}</b> <small>${stations[s.a].ko} – ${stations[s.b].ko}</small></div>`);
}

// ---------------- 팝업 ----------------
function renderPopup() {
  const st = stations[state.selected];
  const t = state.t;
  const entries = st.entries[state.day];
  const rows = entries
    .map((e) => {
      const left = e.t - t;
      const gone = left < 0;
      const stateHtml = gone
        ? `<span class="state gone">막차 떠남</span>`
        : left <= 10
          ? `<span class="state soon">${Math.ceil(left)}분 남음 · 서두르세요</span>`
          : `<span class="state live">${Math.floor(left / 60) ? Math.floor(left / 60) + '시간 ' : ''}${Math.ceil(left % 60)}분 남음</span>`;
      return `<div class="dir ${gone ? 'gone' : ''}">
        ${badge(e.line)}
        <div class="toward">${e.toward} 방면</div>
        <div class="time">${fmt(e.t)}<small>막차</small></div>
        <div class="dest">${e.dest ? e.dest + '행 · ' : ''}${stateHtml}</div>
      </div>`;
    })
    .join('');
  const distChip = state.userPos
    ? `<span class="dist-chip">내 위치 ${fmtDist(distMeters(state.userPos, st.pos))}</span>`
    : '';
  $('popup').innerHTML = `<div class="sheet-handle"></div>
    <button class="close" id="popup-close">×</button>
    <h3>${st.ko}${distChip}</h3><div class="en">${st.en}</div>
    <div class="badges">${st.lines.map((l) => badge(lineById.get(l))).join('')}</div>
    ${rows || '<p class="muted">시간표 데이터 없음</p>'}`;
  $('popup').hidden = false;
  $('popup-close').onclick = () => { state.selected = null; $('popup').hidden = true; render(); };
  // 모바일 바텀시트 핸들 탭으로도 닫기
  const handle = $('popup').querySelector('.sheet-handle');
  if (handle) handle.onclick = () => { state.selected = null; $('popup').hidden = true; render(); };
}
function selectStation(idx, fly = true) {
  state.selected = idx;
  if (fly) {
    const st = stations[idx];
    map.flyTo({
      center: st.pos,
      zoom: Math.max(map.getZoom(), isMobile() ? 12.6 : 12.3),
      padding: isMobile() ? { top: 120, bottom: Math.round(window.innerHeight * 0.44), left: 0, right: 0 } : { top: 0, bottom: 0, left: 0, right: 0 },
      duration: 1000,
    });
  }
  render();
}

// ---------------- 현재 위치 (GPS) ----------------
const gpsBtn = $('btn-gps');
function locateNearest() {
  if (!navigator.geolocation) {
    showToast('이 브라우저에서는 위치 기능을 지원하지 않습니다.');
    return;
  }
  if (!window.isSecureContext && location.hostname !== 'localhost') {
    showToast('GPS는 HTTPS 주소(예: GitHub Pages)에서만 동작합니다.');
    return;
  }
  gpsBtn.classList.add('loading');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      gpsBtn.classList.remove('loading');
      gpsBtn.classList.add('active');
      const here = [pos.coords.longitude, pos.coords.latitude];
      state.userPos = here;
      let bestIdx = 0;
      let bestDist = Infinity;
      for (const st of stations) {
        const d = distMeters(here, st.pos);
        if (d < bestDist) { bestDist = d; bestIdx = st.idx; }
      }
      selectStation(bestIdx, true);
      showToast(`가장 가까운 역: ${stations[bestIdx].ko} (${fmtDist(bestDist)})`);
    },
    (err) => {
      gpsBtn.classList.remove('loading');
      const msg =
        err.code === 1
          ? '위치 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요.'
          : err.code === 3
            ? '위치 확인 시간이 초과되었습니다. 다시 눌러 주세요.'
            : '현재 위치를 확인할 수 없습니다.';
      showToast(msg);
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}
gpsBtn.addEventListener('click', locateNearest);

// ---------------- 검색 ----------------
const input = $('search');
const results = $('search-results');
let activeIdx = -1;
function doSearch() {
  const q = input.value.trim().toLowerCase();
  if (!q) { results.hidden = true; return; }
  const items = [];
  for (const l of lines) if (l.ko.includes(q) || l.en.toLowerCase().includes(q) || q === l.id) items.push({ type: 'line', l });
  for (const s of stations) if (s.ko.toLowerCase().includes(q) || s.en.toLowerCase().includes(q)) items.push({ type: 'st', s });
  items.splice(12);
  results.innerHTML = items
    .map((it, i) =>
      it.type === 'line'
        ? `<li data-i="${i}">${badge(it.l)} ${it.l.ko} <small>${it.l.en} · 노선 강조</small></li>`
        : `<li data-i="${i}">${it.s.lines.map((l) => badge(lineById.get(l))).join('')} ${it.s.ko} <small>${it.s.en}</small></li>`
    )
    .join('') || '<li><small>결과 없음</small></li>';
  results.hidden = false;
  activeIdx = -1;
  results.querySelectorAll('li[data-i]').forEach((li) => (li.onclick = () => pick(items[+li.dataset.i])));
  results._items = items;
}
function pick(it) {
  results.hidden = true;
  if (it.type === 'line') {
    state.focusLine = state.focusLine === it.l.id ? null : it.l.id;
    input.value = state.focusLine ? it.l.ko : '';
    if (state.focusLine) {
      const pts = segments.filter((s) => s.line.id === it.l.id).flatMap((s) => s.pts);
      const lons = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 120, pitch: map.getPitch(), duration: 1200 });
    }
    render();
  } else {
    input.value = it.s.ko;
    selectStation(it.s.idx);
  }
}
input.addEventListener('input', () => {
  if (!input.value.trim() && state.focusLine) { state.focusLine = null; render(); }
  doSearch();
});
input.addEventListener('keydown', (e) => {
  const items = results._items || [];
  const lis = [...results.querySelectorAll('li[data-i]')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + lis.length) % lis.length;
    lis.forEach((li, i) => li.classList.toggle('active', i === activeIdx));
  } else if (e.key === 'Enter' && items.length) {
    pick(items[Math.max(0, activeIdx)]);
  } else if (e.key === 'Escape') {
    results.hidden = true;
  }
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) results.hidden = true; });

// ---------------- 컨트롤 ----------------
function bindSeg(id, key) {
  const el = $(id);
  el.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      state[key] = b.dataset.v;
      el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      render();
    })
  );
}
bindSeg('seg-day', 'day');
bindSeg('seg-height', 'height');
$('btn-info').onclick = () => ($('info').hidden = false);
$('info-close').onclick = () => ($('info').hidden = true);
$('info').onclick = (e) => { if (e.target.id === 'info') $('info').hidden = true; };

// 타임라인 눈금
const ticks = $('ticks');
for (let m = T_MIN; m <= T_MAX; m += 10) {
  const p = ((m - T_MIN) / (T_MAX - T_MIN)) * 100;
  const major = m % 30 === 0;
  ticks.insertAdjacentHTML('beforeend', `<i class="${major ? 'major' : ''}" style="left:${p}%"></i>${major ? `<span style="left:${p}%">${fmt(m)}</span>` : ''}`);
}
const slider = $('slider');
slider.min = T_MIN; slider.max = T_MAX;
slider.addEventListener('input', () => { state.t = +slider.value; render(); });

// 재생
let last = 0;
const SPEED = 4.5; // 실제 1초 = 4.5분
function loop(ts) {
  if (!state.playing) return;
  const dt = last ? (ts - last) / 1000 : 0;
  last = ts;
  state.t += dt * SPEED;
  if (state.t >= T_MAX) { state.t = T_MAX; setPlaying(false); }
  render();
  requestAnimationFrame(loop);
}
function setPlaying(p) {
  state.playing = p;
  $('icon-play').hidden = p;
  $('icon-pause').hidden = !p;
  if (p) {
    if (state.t >= T_MAX - 0.5) state.t = T_MIN;
    last = 0;
    requestAnimationFrame(loop);
  }
}
$('btn-play').onclick = () => setPlaying(!state.playing);
document.addEventListener('keydown', (e) => {
  if (e.target === input) return;
  if (e.code === 'Space') { e.preventDefault(); setPlaying(!state.playing); }
  if (e.key === 'ArrowRight') { state.t = Math.min(T_MAX, state.t + 1); render(); }
  if (e.key === 'ArrowLeft') { state.t = Math.max(T_MIN, state.t - 1); render(); }
});

// 지금 시각
function nowMinutes() {
  const d = new Date();
  let m = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  let dow = d.getDay();
  if (d.getHours() < 4) { m += 1440; dow = (dow + 6) % 7; } // 새벽은 전날 운행일
  return { m, holiday: dow === 0 || dow === 6 };
}
$('btn-now').onclick = () => {
  const { m, holiday } = nowMinutes();
  state.day = holiday ? 'holiday' : 'weekday';
  $('seg-day').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === state.day));
  state.t = Math.max(T_MIN, Math.min(T_MAX, m));
  setPlaying(false);
  render();
};

// 시작: 현재 시각이 범위 안이면 지금, 아니면 23:30
{
  const { m, holiday } = nowMinutes();
  state.day = holiday ? 'holiday' : 'weekday';
  $('seg-day').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === state.day));
  if (m >= T_MIN && m <= T_MAX) state.t = m;
}
render();
window.__state = state; // 디버깅용
