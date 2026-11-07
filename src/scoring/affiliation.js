'use strict';
/**
 * FR-13…FR-15, PRD §6. Скоринговая модель — экспертная, полностью объяснимая.
 * Веса факторов:
 *   общий руководитель 40–45; общий учредитель 40–45;
 *   устойчивые закупочные связи 15–25; совпадение адреса 9–15 (ослабление для «массовых»);
 *   совместные лоты 10–15; совпадение телефона/email 12; совместные судебные дела 10;
 *   одинаковый ОКЭД + регион 3.
 * Модификаторы: штраф за длину пути, бонус +5 за каждый доп. независимый тип фактора, потолок 100.
 */

const WEIGHTS = {
  director_of: { base: 40, max: 45, label: 'Общий руководитель' },
  founder_of: { base: 40, max: 45, label: 'Общий учредитель/участник' },
  shareholder_of: { base: 40, max: 45, label: 'Общий акционер' },
  supplies_to: { base: 15, max: 25, label: 'Устойчивые закупочные связи' },
  located_at: { base: 9, max: 15, label: 'Совпадение адреса регистрации' },
  competed_with: { base: 10, max: 15, label: 'Совместные лоты в закупках' },
  contact_of: { base: 12, max: 12, label: 'Совпадение телефона/email' },
  court_case: { base: 10, max: 10, label: 'Совместные судебные дела' },
  same_oked_region: { base: 3, max: 3, label: 'Одинаковый ОКЭД + регион' },
};

const DIVERSITY_BONUS = 5;
const MAX_SCORE = 100;

/** Штраф за длину пути: 1 ребро = ×1.0; 2 = ×0.85; 3 = ×0.7; 4 = ×0.55. */
function pathPenalty(len) {
  if (len <= 1) return 1.0;
  if (len === 2) return 0.85;
  if (len === 3) return 0.7;
  return 0.55;
}

/** FR-14. Группировка парных рёбер через одного посредника в один фактор. */
function groupPairPaths(paths, graph) {
  const groups = new Map(); // key: `${type}:${viaUid}` -> { type, viaUid, paths }
  const singles = [];
  for (const path of paths) {
    if (path.length === 2 && path[0].type === path[1].type &&
        (path[0].type === 'founder_of' || path[0].type === 'director_of' ||
         path[0].type === 'shareholder_of' || path[0].type === 'affiliated_with')) {
      const via = path[0].from === path[1].to ? path[0].from
        : (path[0].to === path[1].from ? path[0].to
        : (path[0].to === path[1].to ? path[0].to : path[0].from));
      const key = `${path[0].type}:${via}`;
      if (!groups.has(key)) groups.set(key, { type: path[0].type, viaUid: via, paths: [] });
      groups.get(key).paths.push(path);
    } else {
      singles.push(path);
    }
  }
  return { groups, singles };
}

function describeFactorLabel(type, graph, viaUid, path) {
  const w = WEIGHTS[type];
  const baseLabel = w ? w.label : type;
  if (viaUid && graph) {
    const via = graph.nodes.get(viaUid);
    if (via) {
      if (type === 'founder_of') return `${baseLabel}: ${via.name} — учредитель обеих организаций`;
      if (type === 'director_of') return `${baseLabel}: ${via.name} — руководитель обеих организаций`;
      if (type === 'shareholder_of') return `${baseLabel}: ${via.name} — акционер обеих организаций`;
    }
  }
  if (type === 'located_at' && path && path.length === 1 && path[0].meta && path[0].meta.address) {
    return `${baseLabel}: ${path[0].meta.address}`;
  }
  return baseLabel;
}

function dedupeEvidence(list) {
  const seen = new Set();
  const out = [];
  for (const ev of list) {
    const key = `${ev.source}|${ev.url}|${ev.note}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  return out;
}

function collectEvidence(path) {
  return dedupeEvidence(path.flatMap((rel) =>
    (rel.evidence || []).map((ev) => ({
      source: ev.source, url: ev.url, collected_at: ev.collected_at, note: ev.note,
    }))
  ));
}

/**
 * Основная функция скоринга.
 * Логика (PRD §6):
 *   1) выявляем «прямые» факторы между A и B — одиночные рёбра и парные через одного посредника;
 *      каждый тип оценивается полным весом;
 *   2) опосредованные связи (длиннее 2 рёбер) оцениваются со штрафом за длину пути;
 *   3) бонус +5 за каждый дополнительный независимый тип фактора, потолок 100.
 * @param {RelationGraph} graph
 * @param {string} aUid
 * @param {string} bUid
 * @param {object[]} extraFactors дополнительные факторы (например, same_oked_region)
 */
function scoreAffiliation(graph, aUid, bUid, extraFactors = []) {
  const paths = graph.findPaths(aUid, bUid, 4)
    .filter((p) => !p.some((r) => r.type === 'same_person')); // служебная связь не участвует

  const factors = [];
  const { groups, singles } = groupPairPaths(paths, graph);

  // сгруппированные факторы (через одного посредника) — без штрафа длины (FR-14)
  for (const g of groups.values()) {
    const w = WEIGHTS[g.type];
    if (!w) continue;
    const strength = Math.min(1, g.paths.length / 2 + 0.5);
    const value = w.base + (w.max - w.base) * strength;
    const allPaths = g.paths;
    const evidence = allPaths.flatMap((p) => collectEvidence(p));
    factors.push({
      type: g.type,
      label: describeFactorLabel(g.type, graph, g.viaUid),
      value: Math.round(value),
      paths: allPaths.map((p) => p.map((r) => r.type)),
      evidence,
    });
  }
  const groupedPaths = new Set([...groups.values()].flatMap((g) => g.paths));

  // одиночные пути (прямые рёбра и опосредованные связи)
  for (const path of singles) {
    if (groupedPaths.has(path)) continue;
    const types = path.map((r) => r.type);
    const mainType = types.find((t) => WEIGHTS[t]) || types[0];
    const w = WEIGHTS[mainType];
    if (!w) continue;
    const len = path.length;
    const value = w.base * pathPenalty(len);
    factors.push({
      type: mainType,
      label: describeFactorLabel(mainType, graph, null, path),
      value: Math.round(value),
      paths: [types],
      evidence: collectEvidence(path),
    });
  }

  // дополнительные факторы (ОКЭД+регион и пр.)
  for (const f of extraFactors) {
    const w = WEIGHTS[f.type];
    if (!w) continue;
    factors.push({ type: f.type, label: f.label || w.label, value: w.base, paths: [], evidence: f.evidence || [] });
  }

  // объединение одинаковых типов факторов: максимум до потолка w.max
  const byType = new Map();
  for (const f of factors) {
    const w = WEIGHTS[f.type];
    const cap = w ? w.max : 100;
    const prev = byType.get(f.type);
    if (!prev) byType.set(f.type, { ...f, value: Math.min(f.value, cap) });
    else {
      prev.value = Math.min(cap, Math.max(prev.value, f.value));
      prev.evidence = dedupeEvidence(prev.evidence.concat(f.evidence));
      prev.paths = prev.paths.concat(f.paths);
    }
  }
  const merged = [...byType.values()];

  // ослабление «массовых адресов»: если у адресного фактора слишком много однотипных путей,
  // адрес считается массовым (эвристика MVP)
  for (const f of merged) {
    if (f.type === 'located_at' && f.paths.length > 2) {
      f.value = Math.round(f.value * 0.7);
      f.label += ' (ослаблено: массовый адрес)';
    }
  }

  // бонус за разнообразие факторов
  const distinct = new Set(merged.map((f) => f.type));
  const diversityBonus = Math.max(0, distinct.size - 1) * DIVERSITY_BONUS;

  const raw = merged.reduce((s, f) => s + f.value, 0) + diversityBonus;
  const score = Math.min(MAX_SCORE, Math.max(0, Math.round(raw)));

  const verdict = score === 0 ? 'не выявлена'
    : score < 20 ? 'слабая'
    : score < 50 ? 'умеренная'
    : score < 75 ? 'высокая'
    : 'очень высокая';

  return { score, verdict, factors: merged, diversityBonus };
}

module.exports = { scoreAffiliation, WEIGHTS, pathPenalty };
