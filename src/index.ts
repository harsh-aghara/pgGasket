export interface LeakInfo {
	/** Unique checkout identifier. */
	id: number;
	/** Milliseconds the checkout has been held so far. */
	held: number;
	/** Configured leak threshold in milliseconds. */
	threshold: number;
	/** Formatted stack trace if sampled and available. */
	stack?: string;
	/** Current pool connection counts. */
	pool: {
		total: number;
		idle: number;
		waiting: number;
	};
}

export type WarningLogger =
	| ((message: string) => void)
	| { warn: (message: string, ...args: unknown[]) => unknown };

export interface GasketOptions {
	/** Milliseconds a checkout may be held before a warning. Default: 5000. */
	threshold?: number;
	/** Fraction of checkout stacks to capture. Default: 1. */
	sampleRate?: number;
	/** Custom logger or function for warning messages, or false to suppress text warnings. Default: console.warn. */
	logger?: WarningLogger | false;
	/** Optional callback invoked with structured data when a connection leak is detected. */
	onLeak?: (info: LeakInfo) => void;
}

type Release = (this: unknown, ...args: unknown[]) => unknown;
type ConnectCallback = (
	error: unknown,
	client?: ClientLike,
	done?: Release
) => unknown;
type PoolLike = Record<PropertyKey, unknown> & { connect: Release };
type ClientLike = { release?: Release };
type StackHolder = { stack?: unknown };
type Entry = {
	id: number;
	client: ClientLike;
	holder?: StackHolder;
	started: number;
	warned: boolean;
	timer?: ReturnType<typeof setTimeout>;
};
type ResolvedConfig = {
	threshold: number;
	sampleRate: number;
	logger?: WarningLogger | false;
	onLeak?: (info: LeakInfo) => void;
};
type State = {
	pool: PoolLike;
	config: ResolvedConfig;
	nextId: number;
	entries: Map<number, Entry>;
	clients: WeakMap<ClientLike, number>;
	capped: boolean;
};

const WRAPPED = Symbol.for('pg-gasket.wrapped');
const rawToProxy = new WeakMap<object, object>();
const runtimeDiagnostics = new Set<string>();
const MAX_TIMER_DELAY = 2_147_483_647;
const MAX_ENTRIES = 1_000;

/** Wrap a node-postgres-compatible pool and warn about long-held checkouts. */
export function wrapPool<T extends object>(
	pool: T,
	options?: GasketOptions
): T {
	const rawPool = pool as T & PoolLike;
	const initialLogger = isValidLogger(options?.logger)
		? options.logger
		: undefined;
	if (
		!pool ||
		typeof pool !== 'object' ||
		typeof rawPool.connect !== 'function'
	) {
		configurationDiagnostic(
			'pool must be an object with a connect function',
			initialLogger
		);
		return pool;
	}

	if (rawPool[WRAPPED]) {
		if (options !== undefined)
			configurationDiagnostic(
				'pool is already wrapped; options were ignored',
				initialLogger
			);
		return pool;
	}
	const previous = rawToProxy.get(pool);
	if (previous) {
		if (options !== undefined)
			configurationDiagnostic(
				'pool is already wrapped; options were ignored',
				initialLogger
			);
		return previous as T;
	}

	const config = resolveOptions(options);
	const state = createState(rawPool, config);
	const methods = new Map<PropertyKey, Release>();
	// eslint-disable-next-line prefer-const
	let proxy: T & PoolLike;

	const connect = function gasketConnect(
		this: unknown,
		...args: unknown[]
	): unknown {
		const callback =
			typeof args[0] === 'function' ? (args[0] as ConnectCallback) : undefined;
		const sampled =
			config.sampleRate > 0 &&
			(config.sampleRate >= 1 || Math.random() < config.sampleRate);
		const holder = sampled ? captureStack(connect) : undefined;
		const rawConnect = Reflect.get(rawPool, 'connect', rawPool) as Release;

		if (callback) {
			const callbackArgs = args.slice();
			callbackArgs[0] = function gasketCallback(
				error: unknown,
				client?: ClientLike,
				done?: Release
			): unknown {
				if (error || !client) return callback(error, client, done);
				const hooked = instrument(client, holder, state);
				return callback(error, client, hooked || done);
			};
			// The real call is intentionally outside every pg-gasket guard.
			return Reflect.apply(
				rawConnect,
				this === proxy || this == null ? rawPool : this,
				callbackArgs
			);
		}

		const result = Reflect.apply(
			rawConnect,
			this === proxy || this == null ? rawPool : this,
			args
		) as Promise<ClientLike>;
		return result.then((client) => {
			instrument(client, holder, state);
			return client;
		});
	};

	const end = function gasketEnd(this: unknown, ...args: unknown[]): unknown {
		cleanupState(state);
		const rawEnd = Reflect.get(rawPool, 'end', rawPool) as Release;
		const result = Reflect.apply(
			rawEnd,
			this === proxy || this == null ? rawPool : this,
			args
		);
		return result === rawPool ? proxy : result;
	};

	proxy = new Proxy(rawPool, {
		get(target, property) {
			const own = Object.getOwnPropertyDescriptor(target, property);
			// Proxy invariants require the exact value for frozen own data properties.
			if (
				own &&
				own.configurable === false &&
				'value' in own &&
				own.writable === false
			)
				return own.value;
			if (property === WRAPPED) return true;
			if (property === 'connect') return connect;

			const value = Reflect.get(target, property, target);
			if (typeof value !== 'function') return value;
			if (property === 'end') return end;

			let method = methods.get(property);
			if (!method) {
				method = function gasketPoolMethod(
					this: unknown,
					...args: unknown[]
				): unknown {
					const current = Reflect.get(target, property, target) as Release;
					const result = Reflect.apply(
						current,
						this === proxy || this == null ? target : this,
						args
					);
					return result === target ? proxy : result;
				};
				methods.set(property, method);
			}
			return method;
		}
	});

	rawToProxy.set(rawPool, proxy);
	return proxy as T;
}

function resolveOptions(options: GasketOptions | undefined): ResolvedConfig {
	const config: ResolvedConfig = { threshold: 5_000, sampleRate: 1 };
	if (options == null) return Object.freeze(config);
	if (typeof options !== 'object' || Array.isArray(options)) {
		configurationDiagnostic('options must be an object; defaults were used');
		return Object.freeze(config);
	}
	const activeLogger = isValidLogger(options.logger)
		? options.logger
		: undefined;
	for (const key of Object.keys(options)) {
		if (
			key !== 'threshold' &&
			key !== 'sampleRate' &&
			key !== 'logger' &&
			key !== 'onLeak'
		)
			configurationDiagnostic(
				`unknown option "${key}" was ignored`,
				activeLogger
			);
	}
	const threshold = options.threshold;
	if (
		typeof threshold !== 'number' ||
		!Number.isFinite(threshold) ||
		threshold <= 0
	) {
		if (threshold !== undefined)
			configurationDiagnostic(
				'threshold must be a positive finite number; 5000 was used',
				activeLogger
			);
	} else if (threshold > MAX_TIMER_DELAY) {
		config.threshold = MAX_TIMER_DELAY;
		configurationDiagnostic(
			`threshold was clamped to ${MAX_TIMER_DELAY}`,
			activeLogger
		);
	} else {
		config.threshold = threshold;
	}
	if (
		typeof options.sampleRate !== 'number' ||
		Number.isNaN(options.sampleRate)
	) {
		if (options.sampleRate !== undefined)
			configurationDiagnostic(
				'sampleRate must be a number; 1 was used',
				activeLogger
			);
	} else if (options.sampleRate < 0 || options.sampleRate > 1) {
		config.sampleRate = Math.max(0, Math.min(1, options.sampleRate));
		configurationDiagnostic(
			`sampleRate was clamped to ${config.sampleRate}`,
			activeLogger
		);
	} else {
		config.sampleRate = options.sampleRate;
	}
	if (options.logger !== undefined) {
		if (isValidLogger(options.logger)) {
			config.logger = options.logger;
		} else {
			configurationDiagnostic(
				'logger must be a function, an object with a warn method, or false; console.warn was used'
			);
		}
	}
	if (options.onLeak !== undefined) {
		if (typeof options.onLeak === 'function') {
			config.onLeak = options.onLeak;
		} else {
			configurationDiagnostic(
				'onLeak must be a function; it was ignored',
				config.logger
			);
		}
	}
	return Object.freeze(config);
}

function createState(pool: PoolLike, config: ResolvedConfig): State {
	return {
		pool,
		config,
		nextId: 1,
		entries: new Map(),
		clients: new WeakMap(),
		capped: false
	};
}

function cleanupState(state: State): void {
	try {
		for (const entry of state.entries.values()) {
			if (entry.timer !== undefined) clearTimeout(entry.timer);
		}
		state.entries.clear();
		state.capped = false;
	} catch (error) {
		runtimeDiagnostic('pool cleanup', error);
	}
}

function instrument(
	client: ClientLike,
	holder: StackHolder | undefined,
	state: State
): Release | undefined {
	try {
		const release = client.release;
		if (typeof release !== 'function')
			throw new TypeError('client.release is not a function');
		const descriptor = Object.getOwnPropertyDescriptor(client, 'release');
		if (descriptor && descriptor.writable === false)
			throw new TypeError('client.release is not writable');

		// eslint-disable-next-line prefer-const
		let id: number | undefined;
		const hookedRelease: Release = function gasketRelease(
			this: unknown,
			...args: unknown[]
		): unknown {
			try {
				clearEntry(state, id);
			} catch (error) {
				runtimeDiagnostic('release bookkeeping', error);
			}
			return Reflect.apply(release, this, args);
		};
		if (
			!Reflect.set(client, 'release', hookedRelease) ||
			client.release !== hookedRelease
		) {
			throw new TypeError('client.release cannot be replaced');
		}
		id = register(state, client, holder);
		return client.release;
	} catch (error) {
		runtimeDiagnostic('checkout instrumentation', error);
		return undefined;
	}
}

function register(
	state: State,
	client: ClientLike,
	holder: StackHolder | undefined
): number | undefined {
	const oldId = state.clients.get(client);
	if (oldId) clearEntry(state, oldId, false);
	if (state.entries.size >= MAX_ENTRIES) {
		if (!state.capped) {
			state.capped = true;
			runtimeDiagnostic(
				'checkout entry cap',
				new RangeError('entry cap reached')
			);
		}
		return undefined;
	}
	const id = state.nextId++;
	const entry: Entry = {
		id,
		client,
		holder,
		started: Date.now(),
		warned: false
	};
	state.entries.set(id, entry);
	state.clients.set(client, id);
	try {
		entry.timer = setTimeout(() => warn(state, id), state.config.threshold);
		const timerWithUnref = entry.timer as unknown as { unref?: () => unknown };
		if (typeof timerWithUnref.unref === 'function') timerWithUnref.unref();
	} catch (error) {
		state.entries.delete(id);
		state.clients.delete(client);
		runtimeDiagnostic('timer creation', error);
	}
	return id;
}

function clearEntry(
	state: State,
	id: number | undefined,
	emitLateNote = true
): void {
	if (!id) return;
	const entry = state.entries.get(id);
	if (!entry) return;
	state.entries.delete(id);
	if (state.clients.get(entry.client) === id)
		state.clients.delete(entry.client);
	if (entry.timer !== undefined) clearTimeout(entry.timer);
	if (entry.warned && emitLateNote)
		safeWarn(
			`pg-gasket: checkout ${entry.id} released after ${elapsed(entry)}ms`,
			state.config.logger
		);
}

function warn(state: State, id: number): void {
	try {
		const entry = state.entries.get(id);
		if (!entry || entry.warned) return;
		entry.warned = true;
		const stack = readStack(entry.holder);
		entry.holder = undefined;
		const counts = poolCounts(state.pool);
		const held = elapsed(entry);

		if (typeof state.config.onLeak === 'function') {
			try {
				state.config.onLeak({
					id: entry.id,
					held,
					threshold: state.config.threshold,
					stack,
					pool: counts
				});
			} catch (error) {
				runtimeDiagnostic('onLeak callback', error);
			}
		}

		safeWarn(
			[
				'pg-gasket: possible connection leak',
				`checkout: ${entry.id}`,
				`held: ${held}ms`,
				`threshold: ${state.config.threshold}ms`,
				stack || 'stack: unavailable',
				`pool: total=${counts.total}, idle=${counts.idle}, waiting=${counts.waiting}`
			].join('\n'),
			state.config.logger
		);
	} catch (error) {
		runtimeDiagnostic('timer callback', error);
	}
}

function captureStack(
	boundary: (...args: unknown[]) => unknown
): StackHolder | undefined {
	try {
		const holder: StackHolder = {};
		const errorWithCapture = Error as ErrorConstructor & {
			captureStackTrace?: (
				target: object,
				constructorOpt?: (...args: unknown[]) => unknown
			) => void;
		};
		if (typeof errorWithCapture.captureStackTrace === 'function')
			errorWithCapture.captureStackTrace(holder, boundary);
		else holder.stack = new Error().stack;
		return holder;
	} catch (error) {
		runtimeDiagnostic('stack capture', error);
		return undefined;
	}
}

function readStack(holder: StackHolder | undefined): string | undefined {
	try {
		if (!holder || typeof holder.stack !== 'string') return undefined;
		const frames = holder.stack
			.split('\n')
			.filter((line) => /^\s*at\s/.test(line));
		return frames.length ? `stack:\n${frames.join('\n')}` : undefined;
	} catch (error) {
		runtimeDiagnostic('stack formatting', error);
		return undefined;
	}
}

function poolCounts(pool: PoolLike): {
	total: number;
	idle: number;
	waiting: number;
} {
	try {
		return {
			total: Number(pool.totalCount) || 0,
			idle: Number(pool.idleCount) || 0,
			waiting: Number(pool.waitingCount) || 0
		};
	} catch (error) {
		runtimeDiagnostic('pool counts', error);
		return { total: 0, idle: 0, waiting: 0 };
	}
}

function elapsed(entry: Entry): number {
	return Math.max(0, Date.now() - entry.started);
}

function safeWarn(message: string, logger?: WarningLogger | false): void {
	if (logger === false) return;
	try {
		if (typeof logger === 'function') {
			logger(message);
		} else if (
			logger &&
			typeof (logger as { warn: (msg: string) => unknown }).warn === 'function'
		) {
			(logger as { warn: (msg: string) => unknown }).warn(message);
		} else {
			console.warn(message);
		}
	} catch (error) {
		runtimeDiagnostic('warning output', error);
	}
}

function configurationDiagnostic(
	problem: string,
	logger?: WarningLogger | false
): void {
	safeWarn(`pg-gasket: configuration: ${problem}`, logger);
}

function isValidLogger(logger: unknown): logger is WarningLogger | false {
	return (
		logger === false ||
		typeof logger === 'function' ||
		(typeof logger === 'object' &&
			logger !== null &&
			typeof (logger as { warn?: unknown }).warn === 'function')
	);
}

function runtimeDiagnostic(category: string, error: unknown): void {
	if (runtimeDiagnostics.has(category)) return;
	runtimeDiagnostics.add(category);
	const name = error instanceof Error ? error.name : 'Error';
	try {
		console.warn(`pg-gasket: internal ${category} failure (${name})`);
	} catch {
		// ignore
	}
}
