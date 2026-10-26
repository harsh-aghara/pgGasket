'use strict';

const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const { join } = require('node:path');

const targetDir = process.argv[2] || 'test/unit';
const extraFlags = process.argv.slice(3);

const rootDir = join(__dirname, '..');
const fullDir = join(rootDir, targetDir);

const files = readdirSync(fullDir)
	.filter((file) => file.endsWith('.test.cjs'))
	.sort()
	.map((file) => join(targetDir, file));

if (files.length === 0) {
	console.error(`No test files found in ${targetDir}`);
	process.exit(1);
}

const result = spawnSync(
	process.execPath,
	[...extraFlags, '--test', ...files],
	{
		cwd: rootDir,
		stdio: 'inherit'
	}
);

if (result.error) {
	console.error(result.error);
	process.exit(1);
}

process.exit(result.status ?? 1);
