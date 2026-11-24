// 서울 열린데이터광장 Open API에서 1~9호선 역별 막차 시간표를 수집합니다.
// 사용법: .env 파일에 SEOUL_OPENAPI_KEY=발급받은키 를 넣은 뒤 `npm run data:timetable` 실행
import fs from 'node:fs';

function loadEnvKey() {
  if (process.env.SEOUL_OPENAPI_KEY) return process.env.SEOUL_OPENAPI_KEY.trim();
  if (!fs.existsSync('.env')) return '';
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*SEOUL_OPENAPI_KEY\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, '').trim();
  }
  return '';
}

const KEY = loadEnvKey();
if (!KEY || KEY.includes('여기에_키를')) {
  console.error('오류: .env 파일에 SEOUL_OPENAPI_KEY가 설정되어 있지 않습니다.');
  console.error('data.seoul.go.kr > 마이페이지 > 인증키 관리에서 일반 인증키를 발급받아 .env에 입력해 주세요.');
  process.exit(1);
}

const BASE = `http://openapi.seoul.go.kr:8088/${encodeURIComponent(KEY)}/json`;
const net = JSON.parse(fs.readFileSync('public/data/network.json', 'utf8'));

function normName(n) {
  let s = (n || '').replace(/\(.*?\)/g, '').replace(/\s+/g, '').trim();
  if (s === '총신대입구') s = '이수';
  if (s !== '서울역' && s.endsWith('역') && s.length > 2) s = s.slice(0, -1);
  return s;
}

function normLine(l) {
  const m = String(l || '').match(/0?([1-9])호선/);
  return m ? m[1] : null;
}

function parseMinutes(hhmmss) {
  if (!hhmmss || hhmmss === '00:00:00') return null;
  const m = String(hhmmss).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 4) h += 24; // 자정 이후 막차 (00:00~03:59 → 24:00~27:59)
  const total = h * 60 + min;
  if (total < 20 * 60 || total > 26 * 60 + 30) return null;
  return total;
}

async function fetchJson(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${BASE}/${path}`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (attempt === 2) return null;
      await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
    }
  }
  return null;
}

// 1) 노선별 역 코드 목록 수집
console.log('역 코드 목록 조회 중...');
const stnCodeMap = new Map(); // `${line}|${normName}` -> STATION_CD
for (let start = 1; start <= 2000; start += 1000) {
  const j = await fetchJson(`SearchSTNBySubwayLineInfo/${start}/${start + 999}`);
  const rows = j?.SearchSTNBySubwayLineInfo?.row;
  if (!rows?.length) {
    const code = j?.RESULT?.CODE;
    if (code && code !== 'INFO-200') {
      console.error('API 오류:', j.RESULT.CODE, j.RESULT.MESSAGE);
      process.exit(1);
    }
    break;
  }
  for (const row of rows) {
    const line = normLine(row.LINE_NUM);
    if (!line) continue;
    const key = `${line}|${normName(row.STATION_NM)}`;
    if (!stnCodeMap.has(key)) stnCodeMap.set(key, row.STATION_CD);
  }
  if (rows.length < 1000) break;
}
console.log(`1~9호선 역 코드 ${stnCodeMap.size}개 매핑됨`);

// 2) 지선별 정방향(fwd)에 해당하는 INOUT_TAG (1=상행/내선, 2=하행/외선)
const FWD_INOUT = {
  '1-gyeongin': '2',
  '1-gyeongbu': '2',
  '1-gwangmyeong': '2',
  '2-main': '1', // 내선순환
  '2-seongsu': '2', // 성수 → 신설동
  '2-sinjeong': '1', // 신도림 → 까치산
  '3-main': '2',
  '4-main': '2',
  '5-main': '2',
  '5-macheon': '2',
  '6-main': '2',
  '7-main': '2',
  '8-main': '2',
  '9-main': '1', // 개화 → 중앙보훈병원 (9호선은 1=중앙보훈병원 방면, 2=개화 방면)
};

// 3) 역별 막차 조회 (동시 6개 제한)
const targets = [];
for (const b of net.branches) {
  for (const si of b.stops) {
    const st = net.stations[si];
    const cd = stnCodeMap.get(`${b.line}|${normName(st.ko)}`);
    if (cd) targets.push({ cd, line: b.line, name: st.ko });
  }
}
const uniqueCds = [...new Map(targets.map((t) => [t.cd, t])).values()];
console.log(`시간표 조회 대상 역 코드: ${uniqueCds.length}개 (평일·휴일 × 상·하행)`);

// cache[cd][weekTag][inoutTag] = { t, dest }
const cache = new Map();
let done = 0;
let hit = 0;

async function fetchOne(cd, weekTag, inoutTag, stationName) {
  const j = await fetchJson(`SearchSTNTimeTableByIDService/1/1000/${cd}/${weekTag}/${inoutTag}`);
  const rows = j?.SearchSTNTimeTableByIDService?.row;
  if (!rows?.length) return null;
  const selfNorm = normName(stationName);
  let bestDep = null;
  let bestAny = null;
  for (const r of rows) {
    const dest = (r.SUBWAYENAME || '').trim();
    const depT = parseMinutes(r.LEFTTIME);
    const anyT = depT ?? parseMinutes(r.ARRIVETIME);
    if (anyT != null && (!bestAny || anyT > bestAny.t)) {
      bestAny = { t: anyT, dest };
    }
    // 실제 출발하는 열차(종착 도착 전용 제외)를 우선 선택
    if (depT != null && normName(dest) !== selfNorm) {
      if (!bestDep || depT > bestDep.t) {
        bestDep = { t: depT, dest };
      }
    }
  }
  return bestDep || bestAny;
}

const CONCURRENCY = 6;
let cursor = 0;
async function worker() {
  while (cursor < uniqueCds.length) {
    const item = uniqueCds[cursor++];
    const entry = {};
    for (const [dayKey, weekTag] of [['weekday', '1'], ['holiday', '2']]) {
      entry[dayKey] = {
        '1': await fetchOne(item.cd, weekTag, '1', item.name),
        '2': await fetchOne(item.cd, weekTag, '2', item.name),
      };
      if (entry[dayKey]['1'] || entry[dayKey]['2']) hit++;
    }
    cache.set(item.cd, entry);
    done++;
    if (done % 30 === 0 || done === uniqueCds.length) {
      process.stdout.write(`\r진행률: ${done}/${uniqueCds.length}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`\n조회 완료 (데이터 확보: ${hit}/${uniqueCds.length * 2})`);

// 4) 지선별 배열 조립 + 누락 구간(코레일 등) 선형 보간
const SPEED_KMH = 38;
const DWELL = 0.5;
function fillMissing(arr, segs, reverse) {
  const n = arr.length;
  const segMin = segs.map((s) => (s.len / 1000 / SPEED_KMH) * 60 + DWELL);
  const out = arr.slice();
  const known = [];
  for (let i = 0; i < n; i++) if (out[i] != null) known.push(i);
  if (!known.length) return out;
  // 앞쪽 외삽
  for (let i = known[0] - 1; i >= 0; i--) {
    out[i] = Math.round((out[i + 1] + (reverse ? segMin[i] : -segMin[i])) * 2) / 2;
  }
  // 뒤쪽 외삽
  for (let i = known.at(-1) + 1; i < n; i++) {
    out[i] = Math.round((out[i - 1] + (reverse ? -segMin[i - 1] : segMin[i - 1])) * 2) / 2;
  }
  // 사이 보간
  for (let k = 0; k < known.length - 1; k++) {
    const a = known[k], b = known[k + 1];
    if (b - a <= 1) continue;
    for (let i = a + 1; i < b; i++) {
      const f = (i - a) / (b - a);
      out[i] = Math.round((out[a] + (out[b] - out[a]) * f) * 2) / 2;
    }
  }
  return out;
}

const days = { weekday: {}, holiday: {} };
let apiSlots = 0;
let totalSlots = 0;

for (const dayKey of ['weekday', 'holiday']) {
  for (const b of net.branches) {
    const fwdTag = FWD_INOUT[b.id] || '2';
    const revTag = fwdTag === '1' ? '2' : '1';
    const first = net.stations[b.stops[0]].ko;
    const last = net.stations[b.stops.at(-1)].ko;
    const fwd = [];
    const rev = [];
    const fwdDest = [];
    const revDest = [];
    for (const si of b.stops) {
      const st = net.stations[si];
      const cd = stnCodeMap.get(`${b.line}|${normName(st.ko)}`);
      const rec = cd ? cache.get(cd)?.[dayKey] : null;
      const f = rec?.[fwdTag] || null;
      const r = rec?.[revTag] || null;
      totalSlots += 2;
      if (f) apiSlots++;
      if (r) apiSlots++;
      fwd.push(f ? f.t : null);
      rev.push(r ? r.t : null);
      fwdDest.push(f?.dest || last);
      revDest.push(r?.dest || first);
    }
    days[dayKey][b.id] = {
      fwd: fillMissing(fwd, b.segs, false),
      rev: fillMissing(rev, b.segs, true),
      fwdDest,
      revDest,
    };
  }
}

const pct = Math.round((apiSlots / Math.max(1, totalSlots)) * 100);
fs.writeFileSync(
  'public/data/timetable.json',
  JSON.stringify({
    source: 'seoul-openapi',
    sourceLabel: `서울 열린데이터광장 (실측 ${pct}%, 미제공 구간 보간)`,
    generatedAt: new Date().toISOString(),
    coverage: { apiSlots, totalSlots, pct },
    days,
  })
);
console.log(`public/data/timetable.json 저장 완료 (API 실측 비율: ${pct}%)`);
