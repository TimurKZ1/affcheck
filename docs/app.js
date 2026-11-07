(() => {
const modules = {};
const cache = {};
function load(id) {
  if (cache[id]) return cache[id].exports;
  const module = cache[id] = { exports: {} };
  modules[id](module, module.exports, (request) => load(resolve(id, request)));
  return module.exports;
}
function resolve(from, request) {
  if (request === "crypto") return "src/browser/crypto.js";
  if (request === "fs" || request === "path") return request;
  const parts = from.split("/").slice(0, -1).concat(request.split("/"));
  const clean = [];
  for (const part of parts) { if (part === "..") clean.pop(); else if (part !== ".") clean.push(part); }
  const base = clean.join("/");
  for (const id of [base, base + ".js", base + "/index.js"]) if (modules[id]) return id;
  throw new Error("Module not found: " + request);
}
modules["src/browser/entry.js"] = function(module, exports, require) {
'use strict';
const { AffiliationEngine } = require('../engine');

window.affcheckDemo = {
  check(a, b) {
    return new AffiliationEngine({ mode: 'demo' }).check(a, b);
  },
};

};
modules["src/engine.js"] = function(module, exports, require) {
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

};
modules["src/graph/index.js"] = function(module, exports, require) {
'use strict';
module.exports = require('./graph');

};
modules["src/graph/graph.js"] = function(module, exports, require) {
'use strict';
/**
 * FR-11/FR-12. Типизированный граф связей и поиск простых путей до глубины 4 (BFS/DFS).
 * Без внешних зависимостей.
 */

class RelationGraph {
  constructor() {
    /** @type {Map<string, object>} uid -> entity */
    this.nodes = new Map();
    /** @type {Map<string, object>} relation.key -> relation */
    this.edges = new Map();
    /** @type {Map<string, object[]>} uid -> outgoing relations */
    this.adj = new Map();
  }

  addNode(entity) {
    const existing = this.nodes.get(entity.uid);
    if (existing) {
      // дедупликация: дополняем реквизиты
      for (const k of ['bin', 'oked', 'kato', 'address', 'reg_date', 'status']) {
        if (!existing[k] && entity[k]) existing[k] = entity[k];
      }
      Object.assign(existing.extra, entity.extra || {});
      existing.evidence.push(...(entity.evidence || []));
      return existing;
    }
    this.nodes.set(entity.uid, entity);
    return entity;
  }

  addRelation(relation) {
    const key = relation.key();
    const existing = this.edges.get(key);
    if (existing) {
      existing.weight_hint = Math.max(existing.weight_hint, relation.weight_hint);
      Object.assign(existing.meta, relation.meta || {});
      existing.evidence.push(...(relation.evidence || []));
      return existing;
    }
    this.edges.set(key, relation);
    for (const [a, b] of [[relation.from, relation.to], [relation.to, relation.from]]) {
      if (!this.adj.has(a)) this.adj.set(a, []);
      this.adj.get(a).push(relation);
    }
    return relation;
  }

  neighbors(uid) {
    return this.adj.get(uid) || [];
  }

  /**
   * Все простые пути между from и to до maxDepth рёбер.
   * Возвращает массив путей; путь = массив relations.
   */
  findPaths(from, to, maxDepth = 4) {
    const paths = [];
    const visited = new Set([from]);
    const stack = [];

    const dfs = (current, depth) => {
      if (current === to && stack.length > 0) {
        paths.push([...stack]);
        return;
      }
      if (depth >= maxDepth) return;
      for (const rel of this.neighbors(current)) {
        const next = rel.from === current ? rel.to : rel.from;
        if (visited.has(next)) continue;
        visited.add(next);
        stack.push(rel);
        dfs(next, depth + 1);
        stack.pop();
        visited.delete(next);
      }
    };
    dfs(from, 0);
    return paths;
  }
}

module.exports = { RelationGraph };

};
modules["src/sources/index.js"] = function(module, exports, require) {
'use strict';
/**
 * Реестр источников и режимы работы (PRD §4.4, режим выбора источников).
 *   - live: живые коллекторы (требуют сеть и калибровку селекторов);
 *   - demo: только встроенный демо-набор (без сети);
 *   - manual: только ручной импорт;
 *   - all: живые + демо + ручной импорт.
 */
const { DemoSource } = require('./demo');
const { ManualSource } = require('./manual');
const { StatGovSource } = require('./statgov');
const { KgdSource } = require('./kgd');
const { GoszakupSource } = require('./goszakup');
const { KaseSource } = require('./kase');
const { SudSource } = require('./sud');

function buildSources(mode = 'all', { importFiles = [] } = {}) {
  const live = () => [
    new StatGovSource(),
    new KgdSource(),
    new GoszakupSource(),
    new KaseSource(),
    new SudSource(),
  ];
  const manual = () => (importFiles.length > 0 ? [new ManualSource(importFiles)] : []);
  switch (mode) {
    case 'demo': return [new DemoSource()];
    case 'manual': return manual();
    case 'live': return [...live(), ...manual()];
    case 'all':
    default: return [...live(), new DemoSource(), ...manual()];
  }
}

module.exports = { buildSources };

};
modules["src/sources/demo.js"] = function(module, exports, require) {
'use strict';
/**
 * Встроенный демо-набор (PRD §5.2): выдуманная группа компаний для тестов и демонстрации.
 * Кейсы из приложения к PRD:
 *  - «общий учредитель + общий адрес» → 100/100;
 *  - «общий директор + совместные лоты» → ~60/100;
 *  - дальняя связь (4+ посредника) → 0.
 */
const { Source } = require('./base');
const { Entity, Relation, Evidence } = require('../models');

function ev(note) {
  return [new Evidence({ source: 'demo', url: 'demo://dataset', note })];
}

function buildDemoData() {
  const entities = [];
  const relations = [];

  const add = (e) => { entities.push(e); return e; };
  const rel = (r) => { relations.push(r); return r; };

  // --- Кейс 1: общий учредитель + общий адрес + общий контакт (100/100) ---
  const founder1 = add(new Entity({
    type: 'person', name: 'Нурланов Асет Болатулы', bin: '850101300111',
    evidence: ev('демо-персона'),
  }));
  const companyA = add(new Entity({
    type: 'company', name: 'ТОО «Альфа Строй»', bin: '100140001111',
    oked: '41201', kato: '751010000', address: 'г. Алматы, ул. Абая, д. 10, офис 5',
    reg_date: '2014-03-11', status: 'Действующее', evidence: ev('демо-компания A'),
  }));
  const companyB = add(new Entity({
    type: 'company', name: 'ТОО «Бета Логистик»', bin: '110240002222',
    oked: '49410', kato: '751010000', address: 'г. Алматы, ул. Абая, 10, оф. 5',
    reg_date: '2016-07-02', status: 'Действующее', evidence: ev('демо-компания B'),
  }));
  rel(new Relation({
    from: founder1.uid, to: companyA.uid, type: 'founder_of', weight_hint: 1.0,
    meta: { role: 'Учредитель' }, evidence: ev('Нурланов — учредитель Альфа Строй'),
  }));
  rel(new Relation({
    from: founder1.uid, to: companyB.uid, type: 'founder_of', weight_hint: 1.0,
    meta: { role: 'Учредитель' }, evidence: ev('Нурланов — учредитель Бета Логистик'),
  }));
  // адреса совпадают
  rel(new Relation({
    from: companyA.uid, to: companyB.uid, type: 'located_at', weight_hint: 1.0,
    meta: { address: 'г. Алматы, ул. Абая, д. 10, офис 5' }, evidence: ev('совпадение адреса регистрации'),
  }));
  // общий контактный телефон (как в досье обеих компаний)
  rel(new Relation({
    from: companyA.uid, to: companyB.uid, type: 'contact_of', weight_hint: 1.0,
    meta: { phone: '+7 727 300-00-00' }, evidence: ev('совпадение контактного телефона'),
  }));

  // --- Кейс 2: общий директор + совместные лоты (~60/100) ---
  const director2 = add(new Entity({
    type: 'person', name: 'Сериков Даурен Маратович', bin: '870215402222',
    evidence: ev('демо-персона'),
  }));
  const companyC = add(new Entity({
    type: 'company', name: 'ТОО «Гамма Сервис»', bin: '120340003333',
    oked: '62010', kato: '751010000', address: 'г. Астана, пр. Мангилик Ел, 25',
    reg_date: '2018-01-20', status: 'Действующее', evidence: ev('демо-компания C'),
  }));
  const companyD = add(new Entity({
    type: 'company', name: 'ТОО «Дельта Трейд»', bin: '130440004444',
    oked: '46900', kato: '751010000', address: 'г. Астана, ул. Кенесары, 40',
    reg_date: '2019-05-14', status: 'Действующее', evidence: ev('демо-компания D'),
  }));
  rel(new Relation({
    from: director2.uid, to: companyC.uid, type: 'director_of', weight_hint: 1.0,
    meta: { role: 'Директор' }, evidence: ev('Сериков — директор Гамма Сервис'),
  }));
  rel(new Relation({
    from: director2.uid, to: companyD.uid, type: 'director_of', weight_hint: 1.0,
    meta: { role: 'Директор' }, evidence: ev('Сериков — директор Дельта Трейд'),
  }));
  rel(new Relation({
    from: companyC.uid, to: companyD.uid, type: 'competed_with', weight_hint: 0.8,
    meta: { lots: ['LOT-2023-001', 'LOT-2023-017', 'LOT-2024-102'] },
    evidence: ev('совместные лоты в госзакупках (3)'),
  }));

  // --- Кейс 3: цепочка из 5 посредников (связь глубже 4 — не должна находиться) ---
  const chainNodes = [];
  for (let i = 0; i < 7; i++) {
    chainNodes.push(add(new Entity({
      type: 'company', name: `ТОО «Цепочка-${i}»`, bin: `90000000001${i}`,
      oked: '46900', kato: '751010000', address: `г. Алматы, ул. Цепочки, ${i}`,
      evidence: ev(`демо-цепочка ${i}`),
    })));
  }
  for (let i = 0; i < chainNodes.length - 1; i++) {
    rel(new Relation({
      from: chainNodes[i].uid, to: chainNodes[i + 1].uid, type: 'supplies_to',
      weight_hint: 0.4, meta: {}, evidence: ev(`поставка ${i}→${i + 1}`),
    }));
  }

  // --- Несвязанная компания ---
  add(new Entity({
    type: 'company', name: 'ТОО «Омега Консалт»', bin: '150140005555',
    oked: '70220', kato: '751010000', address: 'г. Караганда, ул. Ленина, 1',
    evidence: ev('демо-компания Omega'),
  }));

  return { entities, relations };
}

class DemoSource extends Source {
  constructor() {
    super('demo');
    const data = buildDemoData();
    this.entities = data.entities;
    this.relations = data.relations;
  }

  async search(query) {
    const q = String(query).toLowerCase().replace(/[«»"']/g, ' ').replace(/\s+/g, ' ').trim();
    const qBin = q.replace(/\D/g, '');
    const matched = this.entities.filter((e) => {
      if (qBin.length === 12 && e.bin === qBin) return true;
      return e.name.toLowerCase().includes(q) || q.includes(e.name.toLowerCase());
    });
    // вернуть все связи, где участвуют найденные сущности
    const uids = new Set(matched.map((e) => e.uid));
    const relations = this.relations.filter((r) => uids.has(r.from) || uids.has(r.to));
    return { entities: matched, relations };
  }

  async fetchDetails(entity) {
    const relations = this.relations.filter((r) => r.from === entity.uid || r.to === entity.uid);
    const uids = new Set();
    for (const r of relations) { uids.add(r.from); uids.add(r.to); }
    const entities = this.entities.filter((e) => uids.has(e.uid));
    return { entities, relations };
  }
}

module.exports = { DemoSource };

};
modules["src/sources/base.js"] = function(module, exports, require) {
'use strict';
/**
 * Контракт источника (PRD §5.2, §7):
 *   - id: строковый идентификатор
 *   - search(query) -> { entities, relations } | []
 *   - fetchDetails(uid) -> { entity, relations } | null
 * Любая ошибка оборачивается в SourceError движком — проверка не прерывается (FR-4).
 */

class Source {
  constructor(id) { this.id = id; }
  /** Поиск сущностей по строке запроса (БИН/ИИН/название/ФИО). */
  async search(_query) { return { entities: [], relations: [] }; }
  /** Догрузка связей конкретной сущности (expand, глубина 1). */
  async fetchDetails(_entity) { return { entities: [], relations: [] }; }
}

class SourceError extends Error {
  constructor(sourceId, message) {
    super(message);
    this.sourceId = sourceId;
  }
}

module.exports = { Source, SourceError };

};
modules["src/models.js"] = function(module, exports, require) {
'use strict';
const crypto = require('crypto');

function hashName(normalized) {
  return crypto.createHash('sha1').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

class Evidence {
  constructor({ source, url = null, collected_at = null, note = '' }) {
    this.source = source;
    this.url = url;
    this.collected_at = collected_at || new Date().toISOString().slice(0, 10);
    this.note = note;
  }
}

class Entity {
  constructor({ type, name, bin = null, oked = null, kato = null, address = null, reg_date = null, status = null, extra = {}, evidence = [] }) {
    this.type = type;
    this.name = name;
    this.bin = bin || null;
    this.oked = oked || null;
    this.kato = kato || null;
    this.address = address || null;
    this.reg_date = reg_date || null;
    this.status = status || null;
    this.extra = extra || {};
    this.evidence = evidence;
    this.uid = Entity.makeUid(type, name, this.bin);
  }

  static makeUid(type, name, bin) {
    if (bin && /^\d{12}$/.test(bin)) return `${type}:${bin}`;
    return `${type}:${hashName(String(name).toLowerCase().trim())}`;
  }
}

class Relation {
  constructor({ from, to, type, weight_hint = 1.0, meta = {}, evidence = [] }) {
    this.from = from;
    this.to = to;
    this.type = type;
    this.weight_hint = weight_hint;
    this.meta = meta;
    this.evidence = evidence;
  }
  key() { return `${this.from}|${this.to}|${this.type}`; }
}

class SourceStatus {
  constructor({ source, ok, count = 0, error = null }) {
    this.source = source;
    this.ok = ok;
    this.count = count;
    this.error = error;
  }
}

module.exports = { Evidence, Entity, Relation, SourceStatus };

};
modules["src/browser/crypto.js"] = function(module, exports, require) {
'use strict';
function createHash() {
  return {
    update(value) {
      let h1 = 2166136261;
      let h2 = 2246822519;
      for (let i = 0; i < value.length; i++) {
        h1 = Math.imul(h1 ^ value.charCodeAt(i), 16777619);
        h2 = Math.imul(h2 ^ value.charCodeAt(value.length - 1 - i), 1597334677);
      }
      this.digest = () => ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0'));
      return this;
    },
  };
}
module.exports = { createHash };

};
modules["src/sources/manual.js"] = function(module, exports, require) {
'use strict';
/**
 * FR-5. Ручной импорт данных (CSV/JSON) для источников, недоступных для автоматического сбора.
 *
 * JSON-формат:
 * {
 *   "entities": [ { "type": "company", "name": "...", "bin": "...", ... } ],
 *   "relations": [ { "from": "<bin|name>", "to": "<bin|name>", "type": "founder_of", ... } ]
 * }
 *
 * CSV (упрощённый, две колонки обязательны): kind,json  — либо файл entities.csv:
 *   type,name,bin,oked,kato,address,reg_date,status
 * и relations.csv:
 *   from,to,type,weight_hint,note
 */
const fs = require('fs');
const path = require('path');
const { Source, SourceError } = require('./base');
const { Entity, Relation, Evidence } = require('../models');
const { validateBin } = require('../normalize/bin');

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = cols[i] || ''; });
    return row;
  });
}

class ManualSource extends Source {
  /** @param {string[]} files пути к .json / .csv */
  constructor(files) {
    super('manual');
    this.entities = [];
    this.relations = [];
    this._byKey = new Map(); // bin|name -> uid
    for (const f of files) this.load(f);
  }

  _registerEntity(e) {
    this.entities.push(e);
    if (e.bin) this._byKey.set(e.bin, e.uid);
    this._byKey.set(e.name.toLowerCase(), e.uid);
  }

  _resolveKey(key) {
    const k = String(key).trim();
    const bin = validateBin(k);
    if (bin && this._byKey.has(bin)) return this._byKey.get(bin);
    if (this._byKey.has(k.toLowerCase())) return this._byKey.get(k.toLowerCase());
    return null;
  }

  load(file) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.json') this._loadJson(file);
    else if (ext === '.csv') this._loadCsv(file);
    else throw new SourceError(this.id, `unsupported import format: ${file}`);
  }

  _loadJson(file) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ev = () => [new Evidence({ source: 'manual', url: `file://${file}`, note: 'ручной импорт' })];
    for (const e of data.entities || []) {
      this._registerEntity(new Entity({
        type: e.type, name: e.name, bin: e.bin || null, oked: e.oked || null,
        kato: e.kato || null, address: e.address || null, reg_date: e.reg_date || null,
        status: e.status || null, extra: e.extra || {}, evidence: ev(),
      }));
    }
    for (const r of data.relations || []) {
      const fromUid = this._resolveKey(r.from);
      const toUid = this._resolveKey(r.to);
      if (!fromUid || !toUid) continue;
      this.relations.push(new Relation({
        from: fromUid, to: toUid, type: r.type,
        weight_hint: r.weight_hint != null ? Number(r.weight_hint) : 1.0,
        meta: r.meta || {}, evidence: ev(),
      }));
    }
  }

  _loadCsv(file) {
    const rows = readCsv(file);
    const base = path.basename(file).toLowerCase();
    const ev = () => [new Evidence({ source: 'manual', url: `file://${file}`, note: 'ручной импорт' })];
    if (base.includes('relation')) {
      for (const r of rows) {
        const fromUid = this._resolveKey(r.from);
        const toUid = this._resolveKey(r.to);
        if (!fromUid || !toUid) continue;
        this.relations.push(new Relation({
          from: fromUid, to: toUid, type: r.type,
          weight_hint: r.weight_hint ? Number(r.weight_hint) : 1.0,
          meta: r.note ? { note: r.note } : {}, evidence: ev(),
        }));
      }
    } else {
      for (const e of rows) {
        this._registerEntity(new Entity({
          type: e.type, name: e.name, bin: e.bin || null, oked: e.oked || null,
          kato: e.kato || null, address: e.address || null, reg_date: e.reg_date || null,
          status: e.status || null, evidence: ev(),
        }));
      }
    }
  }

  async search(query) {
    const q = String(query).toLowerCase().trim();
    const qBin = q.replace(/\D/g, '');
    const matched = this.entities.filter((e) => {
      if (qBin.length === 12 && e.bin === qBin) return true;
      return e.name.toLowerCase().includes(q);
    });
    const uids = new Set(matched.map((e) => e.uid));
    return {
      entities: matched,
      relations: this.relations.filter((r) => uids.has(r.from) || uids.has(r.to)),
    };
  }

  async fetchDetails(entity) {
    const relations = this.relations.filter((r) => r.from === entity.uid || r.to === entity.uid);
    const uids = new Set();
    for (const r of relations) { uids.add(r.from); uids.add(r.to); }
    return { entities: this.entities.filter((e) => uids.has(e.uid)), relations };
  }
}

module.exports = { ManualSource };

};
modules["fs"] = function(module, exports, require) {
module.exports = {};
};
modules["path"] = function(module, exports, require) {
module.exports = {};
};
modules["src/normalize/bin.js"] = function(module, exports, require) {
'use strict';
/** FR-6. БИН/ИИН: валидация 12 цифр. */
function validateBin(bin) {
  if (bin == null) return null;
  const s = String(bin).replace(/\s+/g, '');
  return /^\d{12}$/.test(s) ? s : null;
}

module.exports = { validateBin };

};
modules["src/sources/statgov.js"] = function(module, exports, require) {
'use strict';
/**
 * stat.gov.kz (ЕГРН РК) — открытый JSON API без ключа.
 * Возвращает реквизиты компании, руководителя, ОКЭД, КАТО, статус.
 * ВНИМАНИЕ: селекторы/поля требуют калибровки при первом живом запуске (PRD, приложение).
 */
const { Source, SourceError } = require('./base');
const { Entity, Relation, Evidence } = require('../models');
const { httpGetJson } = require('./http');
const { validateBin } = require('../normalize/bin');

const API_SEARCH = 'https://stat.gov.kz/api/search'; // TODO: калибровка эндпоинта
const API_DETAILS = 'https://stat.gov.kz/api/company'; // TODO: калибровка эндпоинта

class StatGovSource extends Source {
  constructor() { super('stat.gov.kz'); }

  async search(query) {
    const bin = validateBin(query);
    if (!bin) return { entities: [], relations: [] }; // поиск по имени у API ограничен
    try {
      const data = await httpGetJson(`${API_SEARCH}?bin=${bin}`);
      return this._parseSearch(data, bin);
    } catch (e) {
      throw new SourceError(this.id, `search failed: ${e.message}`);
    }
  }

  async fetchDetails(entity) {
    if (!entity.bin) return { entities: [], relations: [] };
    try {
      const data = await httpGetJson(`${API_DETAILS}/${entity.bin}`);
      return this._parseDetails(data, entity);
    } catch (e) {
      throw new SourceError(this.id, `details failed: ${e.message}`);
    }
  }

  _ev(url, note) {
    return [new Evidence({ source: this.id, url, note })];
  }

  // TODO: калибровка под фактический ответ API
  _parseSearch(data, bin) {
    const item = Array.isArray(data) ? data[0] : (data && data.data) || data;
    if (!item || !item.name) return { entities: [], relations: [] };
    const entity = new Entity({
      type: 'company',
      name: item.name,
      bin,
      oked: item.oked || null,
      kato: item.kato || null,
      address: item.address || null,
      reg_date: item.reg_date || null,
      status: item.status || null,
      evidence: this._ev(`${API_SEARCH}?bin=${bin}`, 'реквизиты ЕГРН'),
    });
    return { entities: [entity], relations: [] };
  }

  // TODO: калибровка под фактический ответ API
  _parseDetails(data, entity) {
    const relations = [];
    const entities = [];
    const head = data && (data.head || data.director || data.rukovoditel);
    if (head && head.name) {
      const person = new Entity({
        type: 'person', name: head.name, bin: head.iin || null,
        evidence: this._ev(`${API_DETAILS}/${entity.bin}`, 'руководитель ЕГРН'),
      });
      entities.push(person);
      relations.push(new Relation({
        from: person.uid, to: entity.uid, type: 'director_of', weight_hint: 1.0,
        meta: { role: head.role || 'Руководитель' },
        evidence: this._ev(`${API_DETAILS}/${entity.bin}`, 'руководитель ЕГРН'),
      }));
    }
    return { entities, relations };
  }
}

module.exports = { StatGovSource };

};
modules["src/sources/http.js"] = function(module, exports, require) {
'use strict';
/** Минимальный HTTP-хелпер на встроенном fetch (Node 18+). Таймаут и ошибки -> throw. */

async function httpGet(url, { timeoutMs = 15000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; affcheck-mvp/0.1; +local)',
        'Accept': 'application/json, text/html, */*',
        ...headers,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const text = await res.text();
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function httpGetJson(url, opts) {
  const text = await httpGet(url, opts);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`not JSON from ${url}: ${e.message}`);
  }
}

module.exports = { httpGet, httpGetJson };

};
modules["src/sources/kgd.js"] = function(module, exports, require) {
'use strict';
/**
 * kgd.gov.kz (КомпРейстр КГД) — налоговые флаги: задолженность, недобросовестный,
 * «безвестно отсутствующий», фиктивное предприятие. Веб-форма, парсинг HTML.
 * TODO: калибровка селекторов при первом живом запуске.
 */
const { Source, SourceError } = require('./base');
const { httpGet } = require('./http');
const { Evidence } = require('../models');
const { validateBin } = require('../normalize/bin');

const URL_CHECK = 'https://kgd.gov.kz/ru/services/taxpayer_search'; // TODO: калибровка

class KgdSource extends Source {
  constructor() { super('kgd.gov.kz'); }

  async search(query) {
    const bin = validateBin(query);
    if (!bin) return { entities: [], relations: [] };
    try {
      const html = await httpGet(`${URL_CHECK}?bin=${bin}`);
      return this._parse(html, bin);
    } catch (e) {
      throw new SourceError(this.id, `kgd failed: ${e.message}`);
    }
  }

  async fetchDetails() { return { entities: [], relations: [] }; }

  // TODO: калибровка HTML-парсера
  _parse(html, bin) {
    const flags = {};
    const text = String(html);
    flags.has_debt = /задолженност/i.test(text) && !/отсутствует задолженност/i.test(text);
    flags.unreliable = /недобросовестн/i.test(text);
    flags.missing = /безвестно отсутствующ/i.test(text);
    flags.fictitious = /фиктивн/i.test(text);
    const ev = [new Evidence({ source: this.id, url: `${URL_CHECK}?bin=${bin}`, note: 'налоговые флаги КГД' })];
    // Возвращаем «обогащение» — extra для существующей сущности: движок объединит.
    const entity = {
      type: 'company',
      name: `BIN:${bin}`, // будет слито по uid с основной записью
      bin,
      extra: { kgd_flags: flags },
      evidence: ev,
    };
    return { entities: [entity], relations: [] };
  }
}

module.exports = { KgdSource };

};
modules["src/sources/goszakup.js"] = function(module, exports, require) {
'use strict';
/**
 * goszakup.gov.kz — договоры поставщиков, заказчики, совместные лоты.
 * Внутренние JSON/HTML эндпоинты. TODO: калибровка при первом живом запуске.
 */
const { Source, SourceError } = require('./base');
const { Entity, Relation, Evidence } = require('../models');
const { httpGet } = require('./http');
const { validateBin } = require('../normalize/bin');

const URL_CONTRACTS = 'https://goszakup.gov.kz/ru/search/contracts'; // TODO: калибровка

class GoszakupSource extends Source {
  constructor() { super('goszakup.gov.kz'); }

  async search(query) {
    const bin = validateBin(query);
    if (!bin) return { entities: [], relations: [] };
    try {
      const html = await httpGet(`${URL_CONTRACTS}?supplier=${bin}`);
      return this._parse(html, bin);
    } catch (e) {
      throw new SourceError(this.id, `goszakup failed: ${e.message}`);
    }
  }

  async fetchDetails() { return { entities: [], relations: [] }; }

  // TODO: калибровка HTML/JSON-парсера
  _parse(html, bin) {
    // Заглушка парсера: в реальном запуске — извлечь договоры, заказчиков, суммы, лоты.
    const contracts = [];
    const entities = [];
    const relations = [];
    const ev = () => [new Evidence({ source: this.id, url: `${URL_CONTRACTS}?supplier=${bin}`, note: 'договоры госзакупок' })];
    // Пример ожидаемой структуры после калибровки:
    for (const c of contracts) {
      const customer = new Entity({
        type: 'company', name: c.customerName, bin: c.customerBin || null, evidence: ev(),
      });
      entities.push(customer);
      relations.push(new Relation({
        from: `company:${bin}`, to: customer.uid, type: 'supplies_to',
        weight_hint: 0.6, meta: { contract: c.number, amount: c.amount }, evidence: ev(),
      }));
    }
    return { entities, relations };
  }
}

module.exports = { GoszakupSource };

};
modules["src/sources/kase.js"] = function(module, exports, require) {
'use strict';
/**
 * kase.kz — публичные списки аффилированных лиц эмитентов («золотые» данные, PRD §5.2).
 * HTML-таблицы. TODO: калибровка селекторов при первом живом запуске.
 */
const { Source, SourceError } = require('./base');
const { Entity, Relation, Evidence } = require('../models');
const { httpGet } = require('./http');
const { validateBin } = require('../normalize/bin');

const URL_AFFIL = 'https://kase.kz/ru/emitters/show'; // TODO: калибровка

class KaseSource extends Source {
  constructor() { super('kase.kz'); }

  async search(query) {
    const bin = validateBin(query);
    if (!bin) return { entities: [], relations: [] };
    try {
      const html = await httpGet(`${URL_AFFIL}/${bin}`);
      return this._parse(html, bin);
    } catch (e) {
      throw new SourceError(this.id, `kase failed: ${e.message}`);
    }
  }

  async fetchDetails() { return { entities: [], relations: [] }; }

  // TODO: калибровка HTML-парсера
  _parse(html, bin) {
    const text = String(html);
    const entities = [];
    const relations = [];
    const ev = () => [new Evidence({ source: this.id, url: `${URL_AFFIL}/${bin}`, note: 'список аффилированных лиц KASE' })];
    // Заглушка: после калибровки — извлечь строки таблицы аффилированных лиц.
    const affiliated = []; // [{ name, iin }]
    for (const a of affiliated) {
      const person = new Entity({ type: 'person', name: a.name, bin: a.iin || null, evidence: ev() });
      entities.push(person);
      relations.push(new Relation({
        from: person.uid, to: `company:${bin}`, type: 'affiliated_with',
        weight_hint: 1.0, meta: {}, evidence: ev(),
      }));
    }
    // подсказка для статуса: таблица не найдена
    if (!/аффилированн/i.test(text)) {
      // не считаем ошибкой — у компании может не быть размещённого списка
    }
    return { entities, relations };
  }
}

module.exports = { KaseSource };

};
modules["src/sources/sud.js"] = function(module, exports, require) {
'use strict';
/**
 * cabinet.sud.kz — судебные дела сторон. Веб-форма.
 * Для промышленного доступа — Комитет по правовой статистике (PRD §5.2).
 * TODO: калибровка при первом живом запуске; вероятна капча/блокировка.
 */
const { Source, SourceError } = require('./base');
const { Relation, Evidence } = require('../models');
const { httpGet } = require('./http');

const URL_CASES = 'https://cabinet.sud.kz/public/search'; // TODO: калибровка

class SudSource extends Source {
  constructor() { super('cabinet.sud.kz'); }

  async search(query) {
    const q = String(query).trim();
    if (!q) return { entities: [], relations: [] };
    try {
      const html = await httpGet(`${URL_CASES}?q=${encodeURIComponent(q)}`);
      return this._parse(html, q);
    } catch (e) {
      throw new SourceError(this.id, `sud failed: ${e.message}`);
    }
  }

  async fetchDetails() { return { entities: [], relations: [] }; }

  // TODO: калибровка HTML-парсера
  _parse(_html, q) {
    // Заглушка: после калибровки — извлечь дела и связать стороны.
    const relations = [];
    const ev = () => [new Evidence({ source: this.id, url: `${URL_CASES}?q=${encodeURIComponent(q)}`, note: 'судебные дела' })];
    return { entities: [], relations, _evidenceFactory: ev };
  }
}

module.exports = { SudSource };

};
modules["src/scoring/index.js"] = function(module, exports, require) {
'use strict';
module.exports = require('./affiliation');

};
modules["src/scoring/affiliation.js"] = function(module, exports, require) {
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

};
modules["src/normalize/index.js"] = function(module, exports, require) {
'use strict';
module.exports = {
  ...require('./bin'),
  ...require('./person'),
  ...require('./company'),
  ...require('./address'),
};

};
modules["src/normalize/person.js"] = function(module, exports, require) {
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

};
modules["src/normalize/company.js"] = function(module, exports, require) {
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

};
modules["src/normalize/address.js"] = function(module, exports, require) {
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

};
load("src/browser/entry.js");
})();
