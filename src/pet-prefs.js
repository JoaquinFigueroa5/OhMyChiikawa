'use strict';
/*
 * Saved pet selection.
 *
 * Accepts both the legacy single-pet pref ({ pet: 'usagi' }) and the current
 * multi-pet one ({ pets: ['usagi', 'chiikawa'] }). Unknown ids and duplicates
 * are dropped, and the result always holds at least one valid pet.
 */
function normalizePetIds(prefs, knownIds, fallback) {
  const valid = new Set(knownIds || []);
  const raw = Array.isArray(prefs && prefs.pets)
    ? prefs.pets
    : (prefs && prefs.pet ? [prefs.pet] : []);
  const out = [];
  for (const id of raw) {
    if (valid.has(id) && !out.includes(id)) out.push(id);
  }
  if (!out.length && valid.has(fallback)) out.push(fallback);
  return out;
}

module.exports = { normalizePetIds };
