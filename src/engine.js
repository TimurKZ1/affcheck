'use strict';
/**
 * Движок (PRD §7):
 *   запрос → resolve (поиск сущности) → expand (догрузка связей, глубина 1)
 *   → граф (RelationGraph, BFS-пути) → скоринг → отчёт.
 * FR-4: недоступность любого источника не прерывает проверку.
 */
const { RelationGraph } = require('./graph');
const { buildSources } = require('./sources');
const { SourceError } = require('./sources/base');
const { SourceStatus } = require('./models');
const { scoreAffiliation } = require('./scoring');
const { validateBin, canonicalPersonName, personNameSimilarity, canonicalCompanyName, sameAddress } = require('./normalize');

class AffiliationEngine {
  constructor({ mode = 'all', importFiles = [] } = {}) {
    this.sources = buildSources(mode, { importFiles });
    this.graph = new RelationGraph();
    this.sourceStatuses = [];
    this.warnings = [];
    this._pendingRelations = [];
  }

  async _safeCall(source, fn, fallback) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof SourceError ? `${e.sourceId}: ${e.message}` : `${source.id}: ${e.message}`;
      this.sourceStatuses.push(new SourceStatus({ source: source.id, ok: false, error: msg }));
      return fallback;
    }
  }

  /** FR-1. Разрешение сущности по БИН/ИИН, названию или ФИО. */
  async resolve(query) {
    const found = [];
    for (const source of this.sources) {
      const res = await this._safeCall(source, () => source.search(query), { entities: [], relations: [] });
      const count = (res.entities || []).length;
      if (count > 0) {
        this.sourceStatuses.push(new SourceStatus({ source: source.id, ok: true, count }));
      }
      for (const e of res.entities || []) found.push(e);
      for (const r of res.relations || []) {
        this._pendingRelations.push(r);
      }
    }
    if (found.length === 0) {
      this.warnings.push(`Не найдено совпадений для «${query}»`);
      return null;
    }
    // выбор лучшего совпадения: приоритет точного БИН
    const bin = validateBin(query);
    let best = null;
    if (bin) {
      best = found.find((e) => e.bin === bin) || null;
    }
    if (!best) {
      // точное совпадение по имени (нормализованному)
      const q = String(query).toLowerCase().trim();
      best = found.find((e) => e.name.toLowerCase() === q) || found[0];
    }
    this.graph.addNode(best);
    // слить реквизиты дубликатов
    for (const e of found) {
      if (e !== best && e.uid === best.uid) this.graph.addNode(e);
    }
    // применить отложенные связи
    for (const r of this._pendingRelations || []) {
      if (this.graph.nodes.has(r.from) && this.graph.nodes.has(r.to)) this.graph.addRelation(r);
    }
    this._pendingRelations = [];
    return best;
  }

  /** FR-2/§7. Догрузка связей глубины 1 для сущности. */
  async expand(entity) {
    for (const source of this.sources) {
      const res = await this._safeCall(source, () => source.fetchDetails(entity), { entities: [], relations: [] });
      for (const e of res.entities || []) this.graph.addNode(e);
      for (const r of res.relations || []) {
        if (this.graph.nodes.has(r.from) && this.graph.nodes.has(r.to)) this.graph.addRelation(r);
      }
    }
  }

  /** FR-10. Слияние узлов одного человека из разных источников по fuzzy-совпадению ФИО. */
  _dedupePersons() {
    const persons = [...this.graph.nodes.values()].filter((n) => n.type === 'person');
    const removed = new Set();
    for (let i = 0; i < persons.length; i++) {
      const a = persons[i];
      if (removed.has(a.uid)) continue;
      for (let j = i + 1; j < persons.length; j++) {
        const b = persons[j];
        if (removed.has(b.uid)) continue;
        if (a.bin && b.bin && a.bin === b.bin) continue; // один uid уже
        const sim = personNameSimilarity(a.name, b.name);
        if (sim >= 0.9) {
          // слить b в a: перенаправить рёбра и перестроить индексы
          for (const rel of [...this.graph.edges.values()]) {
            if (rel.from === b.uid) rel.from = a.uid;
            if (rel.to === b.uid) rel.to = a.uid;
          }
          this.graph.nodes.delete(b.uid);
          removed.add(b.uid);
          // перестроить edges/adj после перенаправления
          const rels = [...this.graph.edges.values()];
          this.graph.edges = new Map();
          this.graph.adj = new Map();
          for (const rel of rels) {
            if (rel.from === rel.to) continue; // самопетли не нужны
            this.graph.addRelation(rel);
          }
        }
      }
    }
  }

  /** FR-13 доп.: фактор «одинаковый ОКЭД + регион». */
  _extraFactors(a, b) {
    const out = [];
    if (a.type === 'company' && b.type === 'company' && a.oked && b.oked && a.kato && b.kato) {
      if (String(a.oked).slice(0, 2) === String(b.oked).slice(0, 2) &&
          String(a.kato).slice(0, 4) === String(b.kato).slice(0, 4)) {
        out.push({ type: 'same_oked_region', label: `Одинаковый ОКЭД (${a.oked}) и регион (КАТО ${a.kato})` });
      }
    }
    // совпадение адреса по нормализации, если прямого ребра нет
    if (a.address && b.address && sameAddress(a.address, b.address, 0.8)) {
      const hasEdge = [...this.graph.edges.values()].some((r) => r.type === 'located_at' &&
        ((r.from === a.uid && r.to === b.uid) || (r.from === b.uid && r.to === a.uid)));
      if (!hasEdge) {
        const { Relation } = require('./models');
        const evidence = (a.evidence || []).concat(b.evidence || []);
        this.graph.addRelation(new Relation({
          from: a.uid, to: b.uid, type: 'located_at', weight_hint: 0.9,
          meta: { address: a.address, derived: true },
          evidence,
        }));
      }
    }
    return out;
  }

  /**
   * FR-16/FR-18. Полная проверка пары.
   * @returns отчёт для веб/CLI/API
   */
  async check(queryA, queryB) {
    const a = await this.resolve(queryA);
    const b = await this.resolve(queryB);
    if (!a || !b) {
      return {
        ok: false,
        warnings: this.warnings,
        sourceStatuses: this.sourceStatuses,
      };
    }
    await this.expand(a);
    await this.expand(b);
    this._dedupePersons();

    const extraFactors = this._extraFactors(a, b);
    const scoring = scoreAffiliation(this.graph, a.uid, b.uid, extraFactors);

    // граф для фронтенда (vis-network)
    const nodes = [...this.graph.nodes.values()].map((n) => ({
      id: n.uid,
      label: n.name,
      group: n.type,
      title: `${n.type}${n.bin ? ` · ${n.bin}` : ''}${n.address ? `\n${n.address}` : ''}`,
      bin: n.bin, oked: n.oked, kato: n.kato, address: n.address,
      reg_date: n.reg_date, status: n.status,
      evidence: n.evidence,
    }));
    const edges = [...this.graph.edges.values()].map((r, i) => ({
      id: i,
      from: r.from,
      to: r.to,
      label: r.type,
      title: `${r.type}${r.meta && r.meta.address ? `\n${r.meta.address}` : ''}`,
      evidence: r.evidence,
    }));

    return {
      ok: true,
      query: { a: queryA, b: queryB },
      entities: { a, b },
      graph: { nodes, edges },
      scoring,
      sourceStatuses: this._mergeStatuses(),
      warnings: this.warnings,
    };
  }

  _mergeStatuses() {
    // один статус на источник: ок, если хотя бы один успешный вызов
    const map = new Map();
    for (const s of this.sourceStatuses) {
      const prev = map.get(s.source);
      if (!prev || s.ok) map.set(s.source, s);
    }
    return [...map.values()];
  }
}

module.exports = { AffiliationEngine };
