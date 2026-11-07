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
