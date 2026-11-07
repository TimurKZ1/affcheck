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
