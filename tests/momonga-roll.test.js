'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const momonga = require(path.join(ROOT, 'src', 'pets', 'momonga'));
const vault = require(path.join(ROOT, 'src', 'asset-vault'));

assert.deepStrictEqual(momonga.actions.roll, {
  base: 'images/momonga_yada/momonga_yada_',
  count: 16,
  pad: 2,
  ext: '.png',
  start: 1,
  fps: 7,
  loops: 1,
  scale: 1,
  speech: { zh: '不要！不要不要！', en: 'Īyā! Yada yada!', ja: 'いや！やだやだ！' }
});

assert.deepStrictEqual(momonga.walk, {
  base: 'images/momonga_walk/momonga_walk_',
  count: 6,
  pad: 2,
  ext: '.png',
  start: 1,
  fps: 9
});

const pak = JSON.parse(vault.decrypt(fs.readFileSync(path.join(ROOT, 'src', 'assets.pak'))).toString('utf8'));
const expectedSize = { w: 708, h: 552 };

function topLeftAlpha(png) {
  let position = 8;
  const idat = [];
  while (position < png.length) {
    const length = png.readUInt32BE(position); position += 4;
    const type = png.toString('ascii', position, position + 4); position += 4;
    const data = png.subarray(position, position + length); position += length + 4;
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') break;
  }
  return zlib.inflateSync(Buffer.concat(idat))[4];
}

for (let index = 0; index < momonga.actions.roll.count; index++) {
  const frame = String(index + momonga.actions.roll.start).padStart(momonga.actions.roll.pad, '0');
  const asset = `${momonga.actions.roll.base}${frame}${momonga.actions.roll.ext}`;
  assert(pak[asset], `${asset} should be packed into assets.pak`);

  const png = Buffer.from(pak[asset], 'base64');
  assert.strictEqual(png.toString('ascii', 1, 4), 'PNG', `${asset} should be a PNG`);
  assert.deepStrictEqual({ w: png.readUInt32BE(16), h: png.readUInt32BE(20) }, expectedSize,
    `${asset} should share the rolling canvas`);
  assert.strictEqual(png[25], 6, `${asset} should be RGBA so its background is transparent`);
  assert.strictEqual(topLeftAlpha(png), 0, `${asset} should have a transparent background corner`);
}

for (let index = 0; index < momonga.walk.count; index++) {
  const frame = String(index + momonga.walk.start).padStart(momonga.walk.pad, '0');
  const asset = `${momonga.walk.base}${frame}${momonga.walk.ext}`;
  assert(pak[asset], `${asset} should be packed into assets.pak`);

  const png = Buffer.from(pak[asset], 'base64');
  assert.strictEqual(png.toString('ascii', 1, 4), 'PNG', `${asset} should be a PNG`);
  assert.strictEqual(png[25], 6, `${asset} should be RGBA so its background is transparent`);
}

console.log('momonga rolling + walking animation ok');
