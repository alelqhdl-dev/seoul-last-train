// 데이터 로딩·전처리 (시간표 + 노선망 → 화면용 구조)
export const T_MIN = 21 * 60 + 30; // 21:30
export const T_MAX = 26 * 60; // 02:00

export function fmt(t) {
  if (t == null || !isFinite(t)) return '–';
  const m = Math.floor(t + 1e-6);
  const h = Math.floor(m / 60) % 24;
  return `${h}:${String(m % 60).padStart(2, '0')}`;
}

function cumFrac(pts) {
  const d = [0];
  for (let i = 1; i < pts.length; i++) {
    const dx = (pts[i][0] - pts[i - 1][0]) * Math.cos((pts[i][1] * Math.PI) / 180);
    const dy = pts[i][1] - pts[i - 1][1];
    d.push(d[i - 1] + Math.hypot(dx, dy));
  }
  const L = d.at(-1) || 1;
  return d.map((v) => v / L);
}

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export async function loadData() {
  const base = import.meta.env.BASE_URL || './';
  const [net, tt] = await Promise.all([
    fetch(`${base}data/network.json`).then((r) => r.json()),
    fetch(`${base}data/timetable.json`).then((r) => r.json()),
  ]);
  const lineById = new Map(net.lines.map((l, i) => [l.id, { ...l, idx: i, rgb: hexToRgb(l.color) }]));
  const stations = net.stations.map((s, i) => ({ ...s, idx: i, entries: { weekday: [], holiday: [] }, end: {}, lastDep: {} }));

  const segments = [];
  for (const b of net.branches) {
    const line = lineById.get(b.line);
    b.lineObj = line;
    b.segList = b.segs.map((s, k) => {
      const seg = { branch: b, k, line, a: b.stops[k], b: b.stops[k + 1], pts: s.pts, frac: cumFrac(s.pts), len: s.len };
      segments.push(seg);
      return seg;
    });
    const first = stations[b.stops[0]].ko;
    const last = stations[b.stops.at(-1)].ko;
    b.towardFwd = b.loop ? '내선순환' : last;
    b.towardRev = b.loop ? '외선순환' : b.id === '6-main' ? '응암순환' : first;
  }

  // 역별 엔트리 (방향별 막차)
  for (const day of ['weekday', 'holiday']) {
    const D = tt.days[day] || {};
    for (const b of net.branches) {
      const d = D[b.id];
      if (!d) continue;
      const n = b.stops.length;
      b.stops.forEach((si, k) => {
        const st = stations[si];
        const push = (dir, t, dest, terminal) => {
          if (t == null) return;
          st.end[day] = Math.max(st.end[day] ?? -1, t);
          if (terminal) return; // 종착역 도착은 출발 막차가 아님
          st.lastDep[day] = Math.max(st.lastDep[day] ?? -1, t);
          st.entries[day].push({ branch: b, line: b.lineObj, dir, t, dest, toward: dir === 'fwd' ? b.towardFwd : b.towardRev });
        };
        push('fwd', d.fwd?.[k], d.fwdDest?.[k], !b.loop && k === n - 1);
        push('rev', d.rev?.[k], d.revDest?.[k], !b.loop && k === 0);
      });
    }
  }
  // 같은 노선·같은 방면 중복 제거(환승역 겹침)
  for (const st of stations) {
    for (const day of ['weekday', 'holiday']) {
      const seen = new Map();
      for (const e of st.entries[day]) {
        const key = e.line.id + '|' + e.toward;
        if (!seen.has(key) || seen.get(key).t < e.t) seen.set(key, e);
      }
      st.entries[day] = [...seen.values()].sort((x, y) => x.line.idx - y.line.idx || x.toward.localeCompare(y.toward));
    }
  }
  return { net, tt, lines: [...lineById.values()], lineById, stations, segments, branches: net.branches };
}

// 세그먼트 위의 비율 f(0~1)에 해당하는 좌표
export function pointOnSeg(seg, f) {
  const { pts, frac } = seg;
  let i = 1;
  while (i < frac.length - 1 && frac[i] < f) i++;
  const f0 = frac[i - 1], f1 = frac[i];
  const u = f1 > f0 ? (f - f0) / (f1 - f0) : 0;
  return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u];
}
