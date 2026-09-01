#!/usr/bin/env node
'use strict';

// Node below 18 has no global fetch; check before anything else loads.
require('./require-node')();

require('../lib/cli')
  .run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
