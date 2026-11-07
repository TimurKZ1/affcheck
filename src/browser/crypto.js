'use strict';
function createHash() {
  return {
    update(value) {
      let h1 = 2166136261;
      let h2 = 2246822519;
      for (let i = 0; i < value.length; i++) {
        h1 = Math.imul(h1 ^ value.charCodeAt(i), 16777619);
        h2 = Math.imul(h2 ^ value.charCodeAt(value.length - 1 - i), 1597334677);
      }
      this.digest = () => ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0'));
      return this;
    },
  };
}
module.exports = { createHash };
