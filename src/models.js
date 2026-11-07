'use strict';
const crypto = require('crypto');

function hashName(normalized) {
  return crypto.createHash('sha1').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

class Evidence {
  constructor({ source, url = null, collected_at = null, note = '' }) {
    this.source = source;
    this.url = url;
    this.collected_at = collected_at || new Date().toISOString().slice(0, 10);
    this.note = note;
  }
}

class Entity {
  constructor({ type, name, bin = null, oked = null, kato = null, address = null, reg_date = null, status = null, extra = {}, evidence = [] }) {
    this.type = type;
    this.name = name;
    this.bin = bin || null;
    this.oked = oked || null;
    this.kato = kato || null;
    this.address = address || null;
    this.reg_date = reg_date || null;
    this.status = status || null;
    this.extra = extra || {};
    this.evidence = evidence;
    this.uid = Entity.makeUid(type, name, this.bin);
  }

  static makeUid(type, name, bin) {
    if (bin && /^\d{12}$/.test(bin)) return `${type}:${bin}`;
    return `${type}:${hashName(String(name).toLowerCase().trim())}`;
  }
}

class Relation {
  constructor({ from, to, type, weight_hint = 1.0, meta = {}, evidence = [] }) {
    this.from = from;
    this.to = to;
    this.type = type;
    this.weight_hint = weight_hint;
    this.meta = meta;
    this.evidence = evidence;
  }
  key() { return `${this.from}|${this.to}|${this.type}`; }
}

class SourceStatus {
  constructor({ source, ok, count = 0, error = null }) {
    this.source = source;
    this.ok = ok;
    this.count = count;
    this.error = error;
  }
}

module.exports = { Evidence, Entity, Relation, SourceStatus };
