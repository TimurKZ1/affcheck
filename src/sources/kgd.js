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
