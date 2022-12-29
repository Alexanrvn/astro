import matter from 'gray-matter';
import type fsMod from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import glob from 'fast-glob';
import { createServer, ErrorPayload as ViteErrorPayload, ViteDevServer } from 'vite';
import { z } from 'zod';
import { AstroSettings } from '../@types/astro.js';
import { AstroError, AstroErrorData } from '../core/errors/index.js';
import { astroContentVirtualModPlugin } from './vite-plugin-content-virtual-mod.js';

export const collectionConfigParser = z.object({
	schema: z.any().optional(),
	slug: z
		.function()
		.args(
			z.object({
				id: z.string(),
				collection: z.string(),
				defaultSlug: z.string(),
				body: z.string(),
				data: z.record(z.any()),
			})
		)
		.returns(z.union([z.string(), z.promise(z.string())]))
		.optional(),
});

export const contentConfigParser = z.object({
	collections: z.record(collectionConfigParser),
});

export type CollectionConfig = z.infer<typeof collectionConfigParser>;
export type ContentConfig = z.infer<typeof contentConfigParser>;

type Entry = {
	id: string;
	collection: string;
	slug: string;
	data: any;
	body: string;
	_internal: { rawData: string; filePath: string };
};

export const msg = {
	collectionConfigMissing: (collection: string) =>
		`${collection} does not have a config. We suggest adding one for type safety!`,
};

export async function getEntrySlug(entry: Entry, collectionConfig: CollectionConfig) {
	return (
		collectionConfig.slug?.({
			id: entry.id,
			data: entry.data,
			defaultSlug: entry.slug,
			collection: entry.collection,
			body: entry.body,
		}) ?? entry.slug
	);
}

export async function getEntryData(entry: Entry, collectionConfig: CollectionConfig) {
	let data = entry.data;
	if (collectionConfig.schema) {
		// Use `safeParseAsync` to allow async transforms
		const parsed = await z.object(collectionConfig.schema).safeParseAsync(entry.data, { errorMap });
		if (parsed.success) {
			data = parsed.data;
		} else {
			const formattedError = new AstroError({
				...AstroErrorData.MarkdownContentSchemaValidationError,
				message: AstroErrorData.MarkdownContentSchemaValidationError.message(
					entry.collection,
					entry.id,
					parsed.error
				),
				location: {
					file: entry._internal.filePath,
					line: getFrontmatterErrorLine(
						entry._internal.rawData,
						String(parsed.error.errors[0].path[0])
					),
					column: 0,
				},
			});
			throw formattedError;
		}
	}
	return data;
}

const flattenPath = (path: (string | number)[]) => path.join('.');

const errorMap: z.ZodErrorMap = (error, ctx) => {
	if (error.code === 'invalid_type') {
		const badKeyPath = JSON.stringify(flattenPath(error.path));
		if (error.received === 'undefined') {
			return { message: `${badKeyPath} is required.` };
		} else {
			return { message: `${badKeyPath} should be ${error.expected}, not ${error.received}.` };
		}
	}
	return { message: ctx.defaultError };
};

function getFrontmatterErrorLine(rawFrontmatter: string, frontmatterKey: string) {
	const indexOfFrontmatterKey = rawFrontmatter.indexOf(`\n${frontmatterKey}`);
	if (indexOfFrontmatterKey === -1) return 0;

	const frontmatterBeforeKey = rawFrontmatter.substring(0, indexOfFrontmatterKey + 1);
	const numNewlinesBeforeKey = frontmatterBeforeKey.split('\n').length;
	return numNewlinesBeforeKey;
}

/**
 * Match YAML exception handling from Astro core errors
 * @see 'astro/src/core/errors.ts'
 */
export function parseFrontmatter(fileContents: string, filePath: string) {
	try {
		// `matter` is empty string on cache results
		// clear cache to prevent this
		(matter as any).clearCache();
		return matter(fileContents);
	} catch (e: any) {
		if (e.name === 'YAMLException') {
			const err: Error & ViteErrorPayload['err'] = e;
			err.id = filePath;
			err.loc = { file: e.id, line: e.mark.line + 1, column: e.mark.column };
			err.message = e.reason;
			throw err;
		} else {
			throw e;
		}
	}
}

export class NotFoundError extends TypeError {}
export class ZodParseError extends TypeError {}

export async function loadContentConfig({
	fs,
	settings,
}: {
	fs: typeof fsMod;
	settings: AstroSettings;
}): Promise<ContentConfig | Error> {
	const contentPaths = getContentPaths({
		srcDir: settings.config.srcDir,
		rootDir: settings.config.root,
		fs,
	});
	if (!contentPaths.config) {
		return new NotFoundError();
	}
	const tempConfigServer: ViteDevServer = await createServer({
		root: fileURLToPath(settings.config.root),
		server: { middlewareMode: true, hmr: false },
		optimizeDeps: { entries: [] },
		clearScreen: false,
		appType: 'custom',
		logLevel: 'silent',
		plugins: [astroContentVirtualModPlugin({ settings })],
	});
	let unparsedConfig;
	try {
		unparsedConfig = await tempConfigServer.ssrLoadModule(contentPaths.config.pathname);
		await tempConfigServer.close();
	} catch {
		await tempConfigServer.close();
		return new NotFoundError();
	}
	const config = contentConfigParser.safeParse(unparsedConfig);
	if (config.success) {
		return config.data;
	} else {
		return new ZodParseError(config.error.message);
	}
}

type ContentCtx =
	| { status: 'loading' }
	| { status: 'loaded'; config: ContentConfig }
	| { status: 'error'; error: NotFoundError | ZodParseError };

type Observable<C> = {
	get: () => C;
	set: (ctx: C) => void;
	subscribe: (fn: (ctx: C) => void) => () => void;
};

export type ContentObservable = Observable<ContentCtx>;

export function contentObservable(initialCtx: ContentCtx): ContentObservable {
	type Subscriber = (ctx: ContentCtx) => void;
	const subscribers = new Set<Subscriber>();
	let ctx = initialCtx;
	function get() {
		return ctx;
	}
	function set(_ctx: ContentCtx) {
		ctx = _ctx;
		subscribers.forEach((fn) => fn(ctx));
	}
	function subscribe(fn: Subscriber) {
		subscribers.add(fn);
		return () => {
			subscribers.delete(fn);
		};
	}
	return {
		get,
		set,
		subscribe,
	};
}

export type ContentPaths = {
	contentDir: URL;
	cacheDir: URL;
	generatedInputDir: URL;
	config?: URL;
};

export function getContentDir({ srcDir }: { srcDir: URL }) {
	return new URL('./content/', srcDir);
}

export function getContentPaths({
	srcDir,
	rootDir,
	fs,
}: {
	srcDir: URL;
	rootDir: URL;
	fs: typeof fsMod;
}): ContentPaths {
	// Find first file extension to match
	const configPath = glob.sync('content.config.{ts,js,mjs}', {
		cwd: fileURLToPath(rootDir),
		absolute: true,
		fs,
	})[0];
	return {
		contentDir: getContentDir({ srcDir }),
		// Output generated types in project root. May change in the future!
		cacheDir: rootDir,
		generatedInputDir: new URL('../../src/content/template/', import.meta.url),
		config: configPath ? pathToFileURL(configPath) : undefined,
	};
}
