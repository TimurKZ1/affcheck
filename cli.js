#!/usr/bin/env node
'use strict';
/**
 * FR-17. CLI:
 *   node cli.js <лицо1> <лицо2> --mode <режим> --json <файл> [--import <файл1,файл2>]
 *
 * Режимы: all (по умолчанию) | live | demo | manual
 */
const fs = require('fs');
const path = require('path');
const { AffiliationEngine } = require('./src/engine');

function parseArgs(argv) {
  const args = { _: [], mode: 'all', json: null, import: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') args.mode = argv[++i];
    else if (a === '--json') args.json = argv[++i];
    else if (a === '--import') args.import = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    else args._.push(a);
  }
  return args;
}

function fmtEvidence(ev) {
  const url = ev.url ? ` ${ev.url}` : '';
  const note = ev.note ? ` — ${ev.note}` : '';
  return `      [${ev.source} · ${ev.collected_at}]${url}${note}`;
}

async function main() {
  const args = parseArgs(process.argv);
  const [a, b] = args._;
  if (!a || !b) {
    console.error('Использование: node cli.js <лицо1> <лицо2> [--mode all|live|demo|manual] [--json report.json] [--import f1.json,f2.csv]');
    process.exit(2);
  }
  const engine = new AffiliationEngine({ mode: args.mode, importFiles: args.import });
  const report = await engine.check(a, b);

  if (!report.ok) {
    console.log('Проверка не выполнена:');
    for (const w of report.warnings) console.log(`  ! ${w}`);
    process.exit(1);
  }

  const { scoring, entities, sourceStatuses, warnings } = report;
  console.log('');
  console.log('Проверка аффилированности');
  console.log(`  A: ${entities.a.name}${entities.a.bin ? ` (БИН/ИИН ${entities.a.bin})` : ''}`);
  console.log(`  B: ${entities.b.name}${entities.b.bin ? ` (БИН/ИИН ${entities.b.bin})` : ''}`);
  console.log('');
  console.log(`  Скоринг: ${scoring.score}/100 — ${scoring.verdict}`);
  console.log('');
  if (scoring.factors.length > 0) {
    console.log('  Факторы:');
    for (const f of scoring.factors) {
      console.log(`    +${f.value}  ${f.label}`);
      for (const ev of f.evidence || []) console.log(fmtEvidence(ev));
    }
  } else {
    console.log('  Факторы не выявлены.');
  }
  if (warnings.length > 0) {
    console.log('');
    console.log('  Предупреждения:');
    for (const w of warnings) console.log(`    ! ${w}`);
  }
  console.log('');
  console.log('  Источники:');
  for (const s of sourceStatuses) {
    console.log(`    ${s.ok ? 'OK  ' : 'FAIL'} ${s.source}${s.ok ? ` (${s.count})` : ` — ${s.error}`}`);
  }

  if (args.json) {
    const out = path.resolve(args.json);
    fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
    console.log('');
    console.log(`  Отчёт сохранён: ${out}`);
  }
}

main().catch((e) => {
  console.error('Ошибка:', e.message);
  process.exit(1);
});
