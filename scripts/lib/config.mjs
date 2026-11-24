// 노선·지선 설정 (범위: 1호선 의정부~인천, 구로~수원, 영등포~광명 / 서동탄 지선 제외 / 2~9호선 전 구간)
export const LINES = [
  { id: '1', ko: '1호선', en: 'Line 1', color: '#1f5fd1' },
  { id: '2', ko: '2호선', en: 'Line 2', color: '#00a84d' },
  { id: '3', ko: '3호선', en: 'Line 3', color: '#ef7c1c' },
  { id: '4', ko: '4호선', en: 'Line 4', color: '#00a5de' },
  { id: '5', ko: '5호선', en: 'Line 5', color: '#996cac' },
  { id: '6', ko: '6호선', en: 'Line 6', color: '#cd7c2f' },
  { id: '7', ko: '7호선', en: 'Line 7', color: '#8a9a1b' },
  { id: '8', ko: '8호선', en: 'Line 8', color: '#e6186c' },
  { id: '9', ko: '9호선', en: 'Line 9', color: '#bdb092' },
];

// OSM relation id. 같은 노선 안에서는 순서가 중요합니다(앞선 지선과 겹치는 부분은 잘라냄).
export const RELATIONS_META = [
  { id: '1-gyeongin', line: '1', ko: '경원·경인', rel: 9849062 }, // 의정부 → 인천
  { id: '1-gyeongbu', line: '1', ko: '경부', rel: 14181831, cutAfter: '수원' }, // 구로 → 수원
  { id: '1-gwangmyeong', line: '1', ko: '광명셔틀', rel: 10881612 }, // (금천구청) → 광명
  { id: '2-main', line: '2', ko: '본선(순환)', rel: 4729409, loop: true }, // 내선순환
  { id: '2-seongsu', line: '2', ko: '성수지선', rel: 4729406 },
  { id: '2-sinjeong', line: '2', ko: '신정지선', rel: 4729407 },
  { id: '3-main', line: '3', ko: '본선', rel: 443803 },
  { id: '4-main', line: '4', ko: '진접', rel: 13938877 }, // 진접 → 사당
  { id: '4-south', line: '4', ko: '과천·안산', rel: 2718884 }, // 불암산 → 오이도 (사당 이후만 남음 → 병합)
  { id: '5-main', line: '5', ko: '본선', rel: 12497486 },
  { id: '5-macheon', line: '5', ko: '마천지선', rel: 4744338 },
  { id: '6-main', line: '6', ko: '본선', rel: 12080315 },
  { id: '7-main', line: '7', ko: '본선', rel: 12746493 },
  { id: '8-main', line: '8', ko: '본선', rel: 2718901 },
  { id: '9-main', line: '9', ko: '본선', rel: 2718888 },
];
