// 간단한 국어의 로마자 표기법(음운 변화 일부만 반영) — 영문명이 없을 때의 최후 수단
const I = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const V = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
const F = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];
// 받침 + 다음 초성이 ㅇ 이면 연음
const LINK = { 1: 'g', 2: 'kk', 4: 'n', 7: 'd', 8: 'r', 16: 'm', 17: 'b', 19: 's', 20: 'ss', 22: 'j', 23: 'ch', 24: 'k', 25: 't', 26: 'p', 27: 'h' };

export function romanize(str) {
  const syl = [];
  for (const ch of str) {
    const c = ch.codePointAt(0) - 0xac00;
    if (c >= 0 && c < 11172) syl.push({ i: Math.floor(c / 588), v: Math.floor((c % 588) / 28), f: c % 28 });
    else syl.push({ raw: ch });
  }
  let out = '';
  for (let k = 0; k < syl.length; k++) {
    const s = syl[k];
    if (s.raw) { out += s.raw; continue; }
    const prev = syl[k - 1];
    let ini = I[s.i];
    if (s.i === 5 && prev && !prev.raw && prev.f === 8) ini = 'l'; // ㄹㄹ
    else if (s.i === 5 && prev && !prev.raw && prev.f !== 0 && prev.f !== 8) ini = 'n';
    if (s.i === 11 && prev && !prev.raw && LINK[prev.f] && prev._linked) ini = prev._linked;
    out += ini + V[s.v];
    const next = syl[k + 1];
    if (s.f) {
      if (next && !next.raw && next.i === 11 && LINK[s.f] && s.f !== 21) { next._link = true; syl[k]._linked = LINK[s.f]; out += ''; syl[k + 1]._pre = LINK[s.f]; }
      else if (next && !next.raw && next.i === 5 && s.f === 8) out += 'l';
      else if (next && !next.raw && (next.i === 2 || next.i === 6) && [1, 2, 24].includes(s.f)) out += 'ng';
      else out += F[s.f];
    }
    if (syl[k + 1] && syl[k + 1]._pre) {
      // 다음 음절 초성으로 연음 처리
      const n = syl[k + 1];
      out += n._pre;
      n._pre = null;
      n.i = 11;
      n._linked = null;
    }
  }
  return out.charAt(0).toUpperCase() + out.slice(1);
}
