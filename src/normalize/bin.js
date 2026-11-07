'use strict';
/** FR-6. БИН/ИИН: валидация 12 цифр. */
function validateBin(bin) {
  if (bin == null) return null;
  const s = String(bin).replace(/\s+/g, '');
  return /^\d{12}$/.test(s) ? s : null;
}

module.exports = { validateBin };
