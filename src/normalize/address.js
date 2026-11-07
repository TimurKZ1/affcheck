'use strict';
/**
 * FR-9. Адреса: нормализация служебных слов (г./ул./офис…), сравнение по токенам с порогом 0.8.
 */

const STOPWORDS = [
  'г', 'город', 'обл', 'область', 'рн', 'район',
  'ул', 'улица', 'пр', 'проспект', 'мкр', 'микрорайон',
  'д', 'дом', 'корп', 'корпус', 'стр', 'строение',
  'оф', 'офис', 'кв', 'квартира', 'каб', 'кабинет',
  'республика', 'казахстан', 'рк',
];

function tokens(addr) {
  return String(addr)
    .toLowerCase()
    .replace(/[.,;«»"()]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.includes(w));
}

function canonicalAddress(addr) {
  return tokens(addr).sort().join(' ');
}

function addressSimilarity(a, b) {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function sameAddress(a, b, threshold = 0.8) {
  return addressSimilarity(a, b) >= threshold;
}

module.exports = { canonicalAddress, addressSimilarity, sameAddress };
