// 홈 화면 아이콘(PNG)을 외부 프로그램 없이 만드는 파일입니다.  실행: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(OUT, { recursive: true });

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// 위쪽을 향한 비행기 모양 (-1~1 좌표)
const PLANE = [
  [0, -0.92], [0.09, -0.8], [0.09, -0.28], [0.78, 0.14], [0.78, 0.3], [0.09, 0.06],
  [0.09, 0.5], [0.32, 0.68], [0.32, 0.8], [0, 0.71], [-0.32, 0.8], [-0.32, 0.68],
  [-0.09, 0.5], [-0.09, 0.06], [-0.78, 0.3], [-0.78, 0.14], [-0.09, -0.28], [-0.09, -0.8],
];
function inside(x, y) {
  let hit = false;
  for (let i = 0, j = PLANE.length - 1; i < PLANE.length; j = i++) {
    const [xi, yi] = PLANE[i];
    const [xj, yj] = PLANE[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function render(size, glyphScale) {
  const rows = [];
  const cos = Math.cos(Math.PI / 4);
  const sin = Math.sin(Math.PI / 4);
  const SS = 4;
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let px = 0; px < size; px++) {
      // 배경: 청록 → 남색 대각선 그라데이션
      const t = (px + py) / (2 * size);
      const bg = [Math.round(18 + (11 - 18) * t), Math.round(150 + (84 - 150) * t), Math.round(136 + (122 - 136) * t)];
      let cover = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = ((px + (sx + 0.5) / SS) / size) * 2 - 1;
          const uy = ((py + (sy + 0.5) / SS) / size) * 2 - 1;
          // 45도 기울여 오른쪽 위로 날아가게
          const rx = (ux * cos + uy * sin) / glyphScale;
          const ry = (-ux * sin + uy * cos) / glyphScale;
          if (inside(rx, ry)) cover++;
        }
      }
      const a = cover / (SS * SS);
      const o = 1 + px * 3;
      for (let c = 0; c < 3; c++) row[o + c] = Math.round(bg[c] * (1 - a) + 255 * a);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 안드로이드는 아이콘 가장자리를 잘라내므로 비행기를 가운데 작게(안전 영역) 그립니다.
writeFileSync(join(OUT, 'icon-192.png'), render(192, 0.56));
writeFileSync(join(OUT, 'icon-512.png'), render(512, 0.56));
writeFileSync(join(OUT, 'apple-touch-icon.png'), render(180, 0.62));
console.log('아이콘 3개 생성 완료 →', OUT);
