'use strict';
const { AffiliationEngine } = require('../engine');

window.affcheckDemo = {
  check(a, b) {
    return new AffiliationEngine({ mode: 'demo' }).check(a, b);
  },
};
