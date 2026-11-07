'use strict';
/**
 * FR-8. Названия компаний: сравнение без ОПФ (ТОО/ЖШС/АО/ҚҚС…), кавычек, регистра.
 */

const OPF = [
  'тоо', 'жшс', 'ао', 'оао', 'зао', 'ип', 'кх', 'пк', 'пко', 'нко',
  'ққс', 'жк', 'ак', 'ллп', 'ллс', 'ал',
];

function tokens(name) {
  return String(name)
    .toLowerCase()
    .replace(/[«»"''()\.,\-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !OPF.includes(w));
}

function canonicalCompanyName(name) {
  return tokens(name).sort().join(' ');
}

function companyNameSimilarity(a, b) {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

module.exports = { canonicalCompanyName, companyNameSimilarity };
