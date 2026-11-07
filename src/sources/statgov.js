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
