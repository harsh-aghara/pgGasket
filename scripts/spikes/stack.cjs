'use strict';

const limits = [0, 1, 10, 100];
for (const limit of limits) {
	const previous = Error.stackTraceLimit;
	Error.stackTraceLimit = limit;
	const holder = capture();
	Error.stackTraceLimit = previous;
	console.log(JSON.stringify({ limit, stack: holder.stack }));
}

async function run() {
	await Promise.resolve();
	const holder = capture();
	console.log(JSON.stringify({ async: true, stack: holder.stack }));
}

function capture() {
	const holder = {};
	Error.captureStackTrace(holder, capture);
	return holder;
}

void run();
