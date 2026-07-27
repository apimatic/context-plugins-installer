#!/usr/bin/env node
'use strict';

require('../src/cli')
  .run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
