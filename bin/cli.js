#!/usr/bin/env node
'use strict';

// Checked before anything else loads. Node below 18 has no global fetch and no
// node:readline/promises, so without this the failure is a bare
// "fetch is not defined" from somewhere deep in the fetch path.
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
