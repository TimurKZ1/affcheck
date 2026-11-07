'use strict';
/**
 * FR-11/FR-12. Типизированный граф связей и поиск простых путей до глубины 4 (BFS/DFS).
 * Без внешних зависимостей.
 */

class RelationGraph {
  constructor() {
    /** @type {Map<string, object>} uid -> entity */
    this.nodes = new Map();
    /** @type {Map<string, object>} relation.key -> relation */
    this.edges = new Map();
    /** @type {Map<string, object[]>} uid -> outgoing relations */
    this.adj = new Map();
  }

  addNode(entity) {
    const existing = this.nodes.get(entity.uid);
    if (existing) {
      // дедупликация: дополняем реквизиты
      for (const k of ['bin', 'oked', 'kato', 'address', 'reg_date', 'status']) {
        if (!existing[k] && entity[k]) existing[k] = entity[k];
      }
      Object.assign(existing.extra, entity.extra || {});
      existing.evidence.push(...(entity.evidence || []));
      return existing;
    }
    this.nodes.set(entity.uid, entity);
    return entity;
  }

  addRelation(relation) {
    const key = relation.key();
    const existing = this.edges.get(key);
    if (existing) {
      existing.weight_hint = Math.max(existing.weight_hint, relation.weight_hint);
      Object.assign(existing.meta, relation.meta || {});
      existing.evidence.push(...(relation.evidence || []));
      return existing;
    }
    this.edges.set(key, relation);
    for (const [a, b] of [[relation.from, relation.to], [relation.to, relation.from]]) {
      if (!this.adj.has(a)) this.adj.set(a, []);
      this.adj.get(a).push(relation);
    }
    return relation;
  }

  neighbors(uid) {
    return this.adj.get(uid) || [];
  }

  /**
   * Все простые пути между from и to до maxDepth рёбер.
   * Возвращает массив путей; путь = массив relations.
   */
  findPaths(from, to, maxDepth = 4) {
    const paths = [];
    const visited = new Set([from]);
    const stack = [];

    const dfs = (current, depth) => {
      if (current === to && stack.length > 0) {
        paths.push([...stack]);
        return;
      }
      if (depth >= maxDepth) return;
      for (const rel of this.neighbors(current)) {
        const next = rel.from === current ? rel.to : rel.from;
        if (visited.has(next)) continue;
        visited.add(next);
        stack.push(rel);
        dfs(next, depth + 1);
        stack.pop();
        visited.delete(next);
      }
    };
    dfs(from, 0);
    return paths;
  }
}

module.exports = { RelationGraph };
