'use strict';

const { mkdirSync, writeFileSync } = require('node:fs');

mkdirSync('dist/esm', { recursive: true });
writeFileSync('dist/esm/package.json', '{"type":"module"}\n');
