'use strict';
/**
 * FR-7. ФИО: каноническая форма с транслитерацией (каз/рус/лат),
 * инвариантность к порядку токенов и неполному отчеству.
 */

const RU2LAT = {
  'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z','и':'i','й':'i',
  'к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f',
  'х':'h','ц':'c','ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'iu','я':'ia',
  'ә':'a','ғ':'g','қ':'q','ң':'n','ө':'o','ұ':'u','ү':'u','һ':'h','і':'i',
};

function transliterate(text) {
  let out = '';
  for (const ch of text.toLowerCase()) {
    if (RU2LAT[ch] !== undefined) out += RU2LAT[ch];
    else if (/[a-z0-9\s-]/.test(ch)) out += ch;
    else out += ' ';
  }
  return out.replace(/\s+/g, ' ').trim();
}

function tokens(name) {
  return transliterate(name)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

function canonicalPersonName(name) {
  return tokens(name).sort().join(' ');
}

function personNameSimilarity(a, b) {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const minSize = Math.min(ta.size, tb.size);
  const maxSize = Math.max(ta.size, tb.size);
  if (inter === minSize) return 0.95; // подмножество (неполное отчество)
  return inter / maxSize;
}

module.exports = { transliterate, canonicalPersonName, personNameSimilarity };
