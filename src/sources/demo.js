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
