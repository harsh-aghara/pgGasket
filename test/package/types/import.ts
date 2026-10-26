import { wrapPool, type GasketOptions, type LeakInfo } from 'pg-gasket';

const options: GasketOptions = {
	threshold: 50,
	sampleRate: 0.5,
	logger: (msg: string) => console.log(msg),
	onLeak: (info: LeakInfo) => {
		const _id: number = info.id;
		const _held: number = info.held;
		const _threshold: number = info.threshold;
		const _stack: string | undefined = info.stack;
		const _total: number = info.pool.total;
	}
};
const pool = {
	connect: async () => ({ release() {} }),
	tag: 'preserved'
};

const wrapped = wrapPool(pool, options);
wrapped.tag.toUpperCase();
