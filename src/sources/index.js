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
