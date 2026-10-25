'use strict';

try {
	const { Pool } = require('pg');
	const pool = new Pool({ max: 1, connectionString: process.env.DATABASE_URL });
	console.log(
		JSON.stringify({
			pgLoaded: true,
			connectType: typeof pool.connect,
			queryType: typeof pool.query
		})
	);
	void pool.end();
} catch (error) {
	console.error(
		'pg probe requires the optional pg peer dependency:',
		error.name
	);
	process.exitCode = 1;
}
