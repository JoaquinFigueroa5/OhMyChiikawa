'use strict';

const assert = require('assert');
const path = require('path');
const { normalizePetIds } = require(path.join(__dirname, '..', 'src', 'pet-prefs'));

const KNOWN = ['usagi', 'chiikawa', 'hachiware', 'momonga'];

// Legacy single-pet pref still loads.
assert.deepStrictEqual(normalizePetIds({ pet: 'chiikawa' }, KNOWN, 'usagi'), ['chiikawa']);

// Current multi-pet pref keeps its order.
assert.deepStrictEqual(normalizePetIds({ pets: ['usagi', 'momonga'] }, KNOWN, 'usagi'), ['usagi', 'momonga']);

// Unknown ids and duplicates are dropped.
assert.deepStrictEqual(
  normalizePetIds({ pets: ['usagi', 'nope', 'usagi', 'hachiware'] }, KNOWN, 'usagi'),
  ['usagi', 'hachiware']
);

// Nothing usable -> fallback, never an empty list.
assert.deepStrictEqual(normalizePetIds({}, KNOWN, 'usagi'), ['usagi']);
assert.deepStrictEqual(normalizePetIds(null, KNOWN, 'usagi'), ['usagi']);
assert.deepStrictEqual(normalizePetIds({ pets: ['nope'] }, KNOWN, 'usagi'), ['usagi']);
assert.deepStrictEqual(normalizePetIds({ pets: [] }, KNOWN, 'usagi'), ['usagi']);

console.log('pet prefs ok');
