'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { cpSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const root = join(__dirname, '..', '..');
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const tarball = execFileSync(npmBin, ['pack', '--json'], {
	cwd: root,
	encoding: 'utf8'
});
const parsed = JSON.parse(tarball);
const packInfo = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
const filename = packInfo?.filename;
if (!filename) {
	throw new Error(
		`Unable to determine package filename from npm pack output: ${tarball}`
	);
}
const folder = mkdtempSync(join(tmpdir(), 'pg-gasket-package-'));

try {
	execFileSync(npmBin, ['init', '-y'], { cwd: folder, stdio: 'ignore' });
	execFileSync(npmBin, ['install', '--ignore-scripts', join(root, filename)], {
		cwd: folder,
		stdio: 'inherit'
	});
	const cjs = execFileSync(
		process.execPath,
		[
			'-e',
			"const x=require('pg-gasket');if(typeof x.wrapPool!=='function')process.exit(1)"
		],
		{ cwd: folder }
	);
	assert.equal(cjs.length, 0);
	const esm = execFileSync(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			"import {wrapPool} from 'pg-gasket';if(typeof wrapPool!=='function')process.exit(1)"
		],
		{ cwd: folder }
	);
	assert.equal(esm.length, 0);
	cpSync(join(root, 'test', 'package', 'types'), join(folder, 'types'), {
		recursive: true
	});
	execFileSync(
		process.execPath,
		[join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'types'],
		{ cwd: folder, stdio: 'inherit' }
	);
} finally {
	rmSync(folder, { recursive: true, force: true });
	rmSync(join(root, filename), { force: true });
}
