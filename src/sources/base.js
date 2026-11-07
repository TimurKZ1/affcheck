'use strict';
/**
 * Контракт источника (PRD §5.2, §7):
 *   - id: строковый идентификатор
 *   - search(query) -> { entities, relations } | []
 *   - fetchDetails(uid) -> { entity, relations } | null
 * Любая ошибка оборачивается в SourceError движком — проверка не прерывается (FR-4).
 */

class Source {
  constructor(id) { this.id = id; }
  /** Поиск сущностей по строке запроса (БИН/ИИН/название/ФИО). */
  async search(_query) { return { entities: [], relations: [] }; }
  /** Догрузка связей конкретной сущности (expand, глубина 1). */
  async fetchDetails(_entity) { return { entities: [], relations: [] }; }
}

class SourceError extends Error {
  constructor(sourceId, message) {
    super(message);
    this.sourceId = sourceId;
  }
}

module.exports = { Source, SourceError };
