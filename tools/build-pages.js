'use strict';
const { copyFileSync, readFileSync, writeFileSync } = require('fs');
const path = require('path');

const modules = new Map();
function resolveFile(from, request) {
  if (request === 'crypto') return 'src/browser/crypto.js';
  if (request === 'fs' || request === 'path') return request;
  if (!request.startsWith('.')) throw new Error(`Unsupported package: ${request}`);
  const base = path.normalize(path.join(path.dirname(from), request));
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    try {
      readFileSync(candidate, 'utf8');
      return candidate.split(path.sep).join('/');
    } catch {}
  }
  throw new Error(`Not found: ${request} from ${from}`);
}
function collect(id) {
  if (modules.has(id)) return;
  const source = id === 'fs' || id === 'path'
    ? 'module.exports = {};'
    : readFileSync(id, 'utf8');
  modules.set(id, source);
  for (const match of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
    collect(resolveFile(id, match[1]));
  }
}
collect('src/browser/entry.js');

let bundle = '(() => {\nconst modules = {};\nconst cache = {};\n';
bundle += 'function load(id) {\n  if (cache[id]) return cache[id].exports;\n';
bundle += '  const module = cache[id] = { exports: {} };\n';
bundle += '  modules[id](module, module.exports, (request) => load(resolve(id, request)));\n';
bundle += '  return module.exports;\n}\n';
bundle += 'function resolve(from, request) {\n';
bundle += '  if (request === "crypto") return "src/browser/crypto.js";\n';
bundle += '  if (request === "fs" || request === "path") return request;\n';
bundle += '  const parts = from.split("/").slice(0, -1).concat(request.split("/"));\n';
bundle += '  const clean = [];\n';
bundle += '  for (const part of parts) { if (part === "..") clean.pop(); else if (part !== ".") clean.push(part); }\n';
bundle += '  const base = clean.join("/");\n';
bundle += '  for (const id of [base, base + ".js", base + "/index.js"]) if (modules[id]) return id;\n';
bundle += '  throw new Error("Module not found: " + request);\n}\n';
for (const [id, source] of modules) {
  bundle += `modules[${JSON.stringify(id)}] = function(module, exports, require) {\n${source}\n};\n`;
}
bundle += 'load("src/browser/entry.js");\n})();\n';
writeFileSync('docs/app.js', bundle);

let html = readFileSync('webapp/static/index.html', 'utf8');
html = html.replace(/\s*<option value="all">Все \(live \+ демо \+ импорт\)<\/option>/, '')
  .replace(/\s*<option value="live">Только живые источники<\/option>/, '')
  .replace('выявление аффилированности по открытым источникам · MVP', 'демо-проверка в браузере · без передачи данных')
  .replace('<script>\nconst $ = (id)', '<script src="./app.js"></script>\n<script>\nconst $ = (id)');
writeFileSync('docs/index.html', html);
copyFileSync('docs/index.html', 'docs/404.html');
