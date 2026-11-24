// 역 노드(railway=station)의 이름·영문명·좌표를 받아 캐시합니다.
import fs from 'node:fs';
import { overpass } from './lib/overpass.mjs';
const q = `[out:json][timeout:120];
(
  node["railway"="station"](37.15,126.55,37.85,127.30);
  node["railway"="halt"](37.15,126.55,37.85,127.30);
);
out;`;
const j = await overpass(q);
fs.writeFileSync('scripts/.cache/osm-stations.json', JSON.stringify(j));
console.log('stations:', j.elements.length);
