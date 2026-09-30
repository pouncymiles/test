// Tiny syllable-based name generator for nations and towns.
const ONSETS = ['b', 'br', 'c', 'cr', 'd', 'dr', 'f', 'g', 'gr', 'h', 'k', 'kr', 'l', 'm', 'n', 'p', 'r', 's', 'st', 'str', 't', 'th', 'tr', 'v', 'vr', 'w', 'z', ''];
const NUCLEI = ['a', 'e', 'i', 'o', 'u', 'ae', 'ai', 'ea', 'ia', 'io', 'ou', 'y'];
const CODAS = ['', '', 'l', 'n', 'r', 's', 'th', 'nd', 'rn', 'sh', 'ld', 'm', 'rd', 'st', 'x'];
const NATION_SUFFIX = ['ia', 'ia', 'land', 'mark', 'heim', 'gard', 'ora', 'esse', 'os', 'ium', 'ar', 'ien', 'wick', 'stan', 'ova'];
const NATION_FORMS = ['Kingdom of', 'Duchy of', 'Empire of', 'Republic of', 'Principality of', 'Realm of', 'March of', 'Free Cities of'];
const TOWN_SUFFIX = ['burg', 'ton', 'ford', 'haven', 'wick', 'mouth', 'stead', 'port', 'bridge', 'gate', 'dale', 'holm', 'by', 'thorpe', 'moor'];

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function syllable(rng) {
  return rng.pick(ONSETS) + rng.pick(NUCLEI) + rng.pick(CODAS);
}

export function baseName(rng, syl = 2) {
  let s = '';
  for (let i = 0; i < syl; i++) s += syllable(rng);
  s = s.replace(/(.)\1+/g, '$1');
  return cap(s);
}

export function nationName(rng) {
  const base = baseName(rng, rng.int(1, 2));
  const withSuffix = base + rng.pick(NATION_SUFFIX);
  if (rng.chance(0.4)) return `${rng.pick(NATION_FORMS)} ${withSuffix}`;
  return withSuffix;
}

export function shortName(full) {
  return full.replace(/^(Kingdom|Duchy|Empire|Republic|Principality|Realm|March|Free Cities) of /, '');
}

export function townName(rng) {
  return baseName(rng, rng.int(1, 2)) + (rng.chance(0.6) ? rng.pick(TOWN_SUFFIX) : '');
}

export function riverName(rng) {
  return baseName(rng, rng.int(1, 2)) + rng.pick([' River', ' River', '', ' Water', ' Flow']);
}
