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
