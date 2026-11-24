// 임시(가상) 막차 시간표 생성 — 실제 API 데이터가 들어오기 전 화면 개발용입니다.
// 각 지선·방향마다 기점 막차 출발 시각을 정하고, 구간 거리로 역별 통과 시각을 계산합니다.
import fs from 'node:fs';

const net = JSON.parse(fs.readFileSync('public/data/network.json', 'utf8'));
const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return ((h >>> 0) % 1000) / 1000; };
const SPEED_KMH = 38; // 정차 제외 평균 주행 속도
const DWELL = 0.5; // 역 정차(분)
const LATEST_ARRIVAL = 25 * 60 + 35; // 01:35

function times(branch, reverse, base) {
  const segMin = branch.segs.map((s) => (s.len / 1000 / SPEED_KMH) * 60 + DWELL);
  const n = branch.stops.length;
  const total = segMin.reduce((a, b) => a + b, 0);
  const t0 = Math.min(base, LATEST_ARRIVAL - total);
  const out = new Array(n);
  if (!reverse) {
    out[0] = t0;
    for (let k = 1; k < n; k++) out[k] = out[k - 1] + segMin[k - 1];
  } else {
    out[n - 1] = t0;
    for (let k = n - 2; k >= 0; k--) out[k] = out[k + 1] + segMin[k];
  }
  return out.map((t) => Math.round(t * 2) / 2);
}

const days = {};
for (const [day, offset] of [['weekday', 0], ['holiday', -12]]) {
  days[day] = {};
  for (const b of net.branches) {
    const first = net.stations[b.stops[0]].ko;
    const last = net.stations[b.stops.at(-1)].ko;
    const baseF = 23 * 60 + 35 + hash(b.id + 'f') * 30 + offset;
    const baseR = 23 * 60 + 35 + hash(b.id + 'r') * 30 + offset;
    days[day][b.id] = {
      fwd: times(b, false, baseF),
      rev: times(b, true, baseR),
      fwdDest: b.stops.map(() => last),
      revDest: b.stops.map(() => first),
    };
  }
}
fs.writeFileSync(
  'public/data/timetable.json',
  JSON.stringify({ source: 'mock', note: '가상 데이터 (API 키 연결 전)', generatedAt: new Date().toISOString(), days })
);
console.log('mock timetable written for', net.branches.length, 'branches');
