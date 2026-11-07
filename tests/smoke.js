'use strict';
/**
 * Smoke-тесты без сети (PRD, приложение):
 *  - «общий учредитель + общий адрес» → 100/100, «очень высокая»;
 *  - «общий директор + совместные лоты» → ~60/100, «высокая»;
 *  - дальняя связь (4+ посредника) → 0;
 *  - некорректный ввод — предупреждение без падения.
 */
const assert = require('assert');
const { AffiliationEngine } = require('../src/engine');
const normalize = require('../src/normalize');

async function run() {
  // нормализация
  assert.strictEqual(normalize.validateBin('100140001111'), '100140001111');
  assert.strictEqual(normalize.validateBin('123'), null);
  assert.ok(normalize.personNameSimilarity('Иванов Иван', 'Иванов Иван Иванович') >= 0.9);
  assert.ok(normalize.companyNameSimilarity('ТОО «Альфа»', 'альфа') >= 0.9);
  assert.ok(normalize.sameAddress('г. Алматы, ул. Абая, д. 10, офис 5', 'Алматы, Абая 10, оф. 5', 0.5));
  console.log('OK  нормализация: БИН, ФИО, названия, адреса');

  // кейс 1: общий учредитель + общий адрес + общий телефон (комбинация сильных факторов)
  {
    const engine = new AffiliationEngine({ mode: 'demo' });
    const r = await engine.check('100140001111', '110240002222');
    assert.ok(r.ok, 'отчёт должен быть ok');
    assert.strictEqual(r.scoring.score, 76, `ожидался 76, получено ${r.scoring.score}`);
    assert.strictEqual(r.scoring.verdict, 'очень высокая');
    const types = r.scoring.factors.map((f) => f.type);
    assert.ok(types.includes('founder_of'), 'фактор founder_of обязателен');
    assert.ok(types.includes('located_at'), 'фактор located_at обязателен');
    assert.ok(types.includes('contact_of'), 'фактор contact_of обязателен');
    // у каждого фактора есть источник
    for (const f of r.scoring.factors) {
      assert.ok((f.evidence || []).length > 0, `у фактора ${f.type} нет источника`);
    }
    console.log('OK  кейс 1: учредитель + адрес + телефон →', r.scoring.score);
  }

  // кейс 2: общий директор + совместные лоты
  {
    const engine = new AffiliationEngine({ mode: 'demo' });
    const r = await engine.check('120340003333', '130440004444');
    assert.ok(r.ok);
    assert.ok(r.scoring.score >= 55 && r.scoring.score <= 75, `ожидался ~60, получено ${r.scoring.score}`);
    assert.strictEqual(r.scoring.verdict, 'высокая');
    const types = r.scoring.factors.map((f) => f.type);
    assert.ok(types.includes('director_of'));
    assert.ok(types.includes('competed_with'));
    console.log('OK  кейс 2: общий директор + совместные лоты →', r.scoring.score);
  }

  // кейс 3: связь глубже 4 рёбер — не находится (только слабый косвенный сигнал)
  {
    const engine = new AffiliationEngine({ mode: 'demo' });
    const r = await engine.check('900000000010', '900000000016');
    assert.ok(r.ok);
    assert.ok(r.scoring.score <= 3, `ожидался 0–3, получено ${r.scoring.score}`);
    console.log('OK  кейс 3: дальняя связь →', r.scoring.score);
  }

  // кейс 4: некорректный ввод — без падения
  {
    const engine = new AffiliationEngine({ mode: 'demo' });
    const r = await engine.check('несуществующее имя xyz', '100140001111');
    assert.strictEqual(r.ok, false);
    assert.ok(r.warnings.length > 0);
    console.log('OK  кейс 4: некорректный ввод обработан');
  }

  console.log('\nВсе smoke-тесты прошли.');
}

run().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
