import type { Bindings } from "./types";

export type IndexEntry =
	| { r2Path: string; lifetimeMinutes: number }
	| { contentType: string; encoding: string; lastModified: number; lifetimeMinutes: number };

const INLINE_MAX_BYTES = 100 * 1024;
const INLINE_MAX_LIFETIME_MINUTES = 2 * 24 * 60;

export async function storeNewContent(
	env: Bindings,
	key: string,
	body: ArrayBuffer,
	contentType: string,
	encoding: string,
	lifetimeMinutes: number,
	modificationKey?: string,
) {
	const expirationTtl = lifetimeMinutes > 0 ? lifetimeMinutes * 60 : undefined;
	const inline =
		!modificationKey &&
		lifetimeMinutes > 0 &&
		lifetimeMinutes <= INLINE_MAX_LIFETIME_MINUTES &&
		body.byteLength <= INLINE_MAX_BYTES;

	if (inline) {
		const entry: IndexEntry = { contentType, encoding, lastModified: Date.now(), lifetimeMinutes };
		await env.INDEX.put(key, body, { metadata: entry, expirationTtl });
		return;
	}

	// The prefix is what R2 lifecycle rules match on to clean up blobs after the KV entry expires.
	const r2Path = `${lifetimeMinutes > 0 ? `${lifetimeMinutes}m` : "forever"}/${key}`;
	await env.CONTENT.put(r2Path, body, {
		httpMetadata: { contentType, contentEncoding: encoding },
		customMetadata: modificationKey ? { modificationKey } : undefined,
	});
	const entry: IndexEntry = { r2Path, lifetimeMinutes };
	await env.INDEX.put(key, "", { metadata: entry, expirationTtl });
}

export function lifetimeFor(env: Bindings, userAgent: string, origin: string, host: string) {
	const overrides = env.LIFETIME_OVERRIDES_MINUTES as Record<string, number>;
	const minutes = overrides[userAgent] ?? overrides[origin] ?? overrides[host] ?? env.DEFAULT_LIFETIME_MINUTES;
	return Math.max(minutes, 0);
}
