// OSM에서 1~9호선 노선(선형)과 정차역을 받아 캐시합니다.
import fs from 'node:fs';
import { overpass } from './lib/overpass.mjs';

import { RELATIONS_META } from './lib/config.mjs';

const ids = RELATIONS_META.map((r) => r.rel).join(',');
const q = `[out:json][timeout:180];
relation(id:${ids})->.r;
.r out geom;
node(r.r);
out;`;
const j = await overpass(q);
fs.mkdirSync('scripts/.cache', { recursive: true });
fs.writeFileSync('scripts/.cache/osm-raw.json', JSON.stringify(j));
console.log('elements:', j.elements.length);

