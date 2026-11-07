'use strict';
/**
 * FR-5. Ручной импорт данных (CSV/JSON) для источников, недоступных для автоматического сбора.
 *
 * JSON-формат:
 * {
 *   "entities": [ { "type": "company", "name": "...", "bin": "...", ... } ],
 *   "relations": [ { "from": "<bin|name>", "to": "<bin|name>", "type": "founder_of", ... } ]
 * }
 *
 * CSV (упрощённый, две колонки обязательны): kind,json  — либо файл entities.csv:
 *   type,name,bin,oked,kato,address,reg_date,status
 * и relations.csv:
 *   from,to,type,weight_hint,note
 */
const fs = require('fs');
const path = require('path');
const { Source, SourceError } = require('./base');
const { Entity, Relation, Evidence } = require('../models');
const { validateBin } = require('../normalize/bin');

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = cols[i] || ''; });
    return row;
  });
}

class ManualSource extends Source {
  /** @param {string[]} files пути к .json / .csv */
  constructor(files) {
    super('manual');
    this.entities = [];
    this.relations = [];
    this._byKey = new Map(); // bin|name -> uid
    for (const f of files) this.load(f);
  }

  _registerEntity(e) {
    this.entities.push(e);
    if (e.bin) this._byKey.set(e.bin, e.uid);
    this._byKey.set(e.name.toLowerCase(), e.uid);
  }

  _resolveKey(key) {
    const k = String(key).trim();
    const bin = validateBin(k);
    if (bin && this._byKey.has(bin)) return this._byKey.get(bin);
    if (this._byKey.has(k.toLowerCase())) return this._byKey.get(k.toLowerCase());
    return null;
  }

  load(file) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.json') this._loadJson(file);
    else if (ext === '.csv') this._loadCsv(file);
    else throw new SourceError(this.id, `unsupported import format: ${file}`);
  }

  _loadJson(file) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ev = () => [new Evidence({ source: 'manual', url: `file://${file}`, note: 'ручной импорт' })];
    for (const e of data.entities || []) {
      this._registerEntity(new Entity({
        type: e.type, name: e.name, bin: e.bin || null, oked: e.oked || null,
        kato: e.kato || null, address: e.address || null, reg_date: e.reg_date || null,
        status: e.status || null, extra: e.extra || {}, evidence: ev(),
      }));
    }
    for (const r of data.relations || []) {
      const fromUid = this._resolveKey(r.from);
      const toUid = this._resolveKey(r.to);
      if (!fromUid || !toUid) continue;
      this.relations.push(new Relation({
        from: fromUid, to: toUid, type: r.type,
        weight_hint: r.weight_hint != null ? Number(r.weight_hint) : 1.0,
        meta: r.meta || {}, evidence: ev(),
      }));
    }
  }

  _loadCsv(file) {
    const rows = readCsv(file);
    const base = path.basename(file).toLowerCase();
    const ev = () => [new Evidence({ source: 'manual', url: `file://${file}`, note: 'ручной импорт' })];
    if (base.includes('relation')) {
      for (const r of rows) {
        const fromUid = this._resolveKey(r.from);
        const toUid = this._resolveKey(r.to);
        if (!fromUid || !toUid) continue;
        this.relations.push(new Relation({
          from: fromUid, to: toUid, type: r.type,
          weight_hint: r.weight_hint ? Number(r.weight_hint) : 1.0,
          meta: r.note ? { note: r.note } : {}, evidence: ev(),
        }));
      }
    } else {
      for (const e of rows) {
        this._registerEntity(new Entity({
          type: e.type, name: e.name, bin: e.bin || null, oked: e.oked || null,
          kato: e.kato || null, address: e.address || null, reg_date: e.reg_date || null,
          status: e.status || null, evidence: ev(),
        }));
      }
    }
  }

  async search(query) {
    const q = String(query).toLowerCase().trim();
    const qBin = q.replace(/\D/g, '');
    const matched = this.entities.filter((e) => {
      if (qBin.length === 12 && e.bin === qBin) return true;
      return e.name.toLowerCase().includes(q);
    });
    const uids = new Set(matched.map((e) => e.uid));
    return {
      entities: matched,
      relations: this.relations.filter((r) => uids.has(r.from) || uids.has(r.to)),
    };
  }

  async fetchDetails(entity) {
    const relations = this.relations.filter((r) => r.from === entity.uid || r.to === entity.uid);
    const uids = new Set();
    for (const r of relations) { uids.add(r.from); uids.add(r.to); }
    return { entities: this.entities.filter((e) => uids.has(e.uid)), relations };
  }
}

module.exports = { ManualSource };
