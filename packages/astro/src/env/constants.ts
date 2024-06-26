export const VIRTUAL_MODULES_IDS = {
	client: 'astro:env/client',
	server: 'astro:env/server',
	internal: 'virtual:astro:env/internal',
};
export const VIRTUAL_MODULES_IDS_VALUES = new Set(Object.values(VIRTUAL_MODULES_IDS));

export const PUBLIC_PREFIX = 'PUBLIC_';
export const ENV_TYPES_FILE = 'env.d.ts';

const PKG_BASE = new URL('../../', import.meta.url);
export const MODULE_TEMPLATE_URL = new URL('templates/env/module.mjs', PKG_BASE);
export const TYPES_TEMPLATE_URL = new URL('templates/env/types.d.ts', PKG_BASE);
