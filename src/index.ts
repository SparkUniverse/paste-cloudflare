import { Hono, type Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { cache, WorkerEntrypoint } from "cloudflare:workers";
import { clientAcceptEncoding, encodeContent, serveContent } from "./encoding";
import { checkRateLimit, generateToken, safeEqual, splitList } from "./security";
import { lifetimeFor, storeNewContent, type IndexEntry } from "./storage";
import type { AppContext, Bindings } from "./types";

const MAX_HEADER_VALUE_LENGTH = 256;

const app = new Hono<{ Bindings: Bindings }>();

app.use(async (c, next) => {
	await next();
	if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
});

app.use(
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "PUT"],
		allowHeaders: [
			"Content-Type",
			"Accept",
			"Origin",
			"Content-Encoding",
			"Authorization",
			"Allow-Modification",
			"Bytebin-Api-Key",
			"Bytebin-Forwarded-For",
		],
		maxAge: 86400,
	}),
);

const limitBody = (c: AppContext, next: Next) =>
	bodyLimit({
		maxSize: c.env.MAX_CONTENT_LENGTH_MB * 1024 * 1024,
		onError: (c) => c.text("Content too large", 413),
	})(c, next);

app.get("/health", (c) => {
	c.header("Cache-Control", "no-cache");
	return c.json({ status: "ok" });
});

app.on(["POST", "PUT"], "/post", limitBody, async (c) => {
	const content = await c.req.arrayBuffer();
	if (content.byteLength === 0) return c.text("Missing content", 400);
	await checkRateLimit(c, c.env.POST_RATE_LIMITER);

	const contentType = boundedHeader(c, "Content-Type") ?? "text/plain";
	const host = new URL(c.req.url).host;
	const lifetimeMinutes = lifetimeFor(
		c.env,
		c.req.header("User-Agent") ?? "null",
		c.req.header("Origin") ?? "null",
		host,
	);
	const modifiable = c.env.ALLOW_MODIFICATION && c.req.header("Allow-Modification")?.toLowerCase() === "true";

	const key = generateToken(c.env.KEY_LENGTH);
	const modificationKey = modifiable ? generateToken(32) : undefined;
	const { body, encoding } = await encodeContent(content, boundedHeader(c, "Content-Encoding"));
	await storeNewContent(c.env, key, body, contentType, encoding, lifetimeMinutes, modificationKey);

	if (modificationKey) c.header("Modification-Key", modificationKey);
	if (c.req.method === "PUT") {
		const hostAliases = c.env.HOST_ALIASES as Record<string, string>;
		const location = `https://${hostAliases[host] ?? host}/${key}`;
		c.header("Location", location);
		return c.text(`${location}\n`, 201);
	}
	c.header("Location", key);
	return c.json({ key }, 201);
});

app.get("/:key{[a-zA-Z0-9]+}", async (c) => {
	// Browser navigations get the paste UI, which then fetches the raw content itself. Sec-Fetch-Dest is
	// only sent by browsers; Accept is not used because Java's default Accept header starts with text/html.
	if (c.req.header("Sec-Fetch-Dest") === "document") {
		const page = await c.env.ASSETS.fetch(new URL("/", c.req.url));
		return new Response(page.body, {
			headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Vary: "Sec-Fetch-Dest" },
		});
	}
	return loadContent(c, c.req.param("key"));
});

app.get("/raw/:key{[a-zA-Z0-9]+}", async (c) => {
	const response = await loadContent(c, c.req.param("key"));
	// Browsers download most text/* subtypes (text/yaml, text/java) instead of displaying them.
	if (response.ok && response.headers.get("Content-Type")?.startsWith("text/")) {
		response.headers.set("Content-Type", "text/plain; charset=utf-8");
	}
	return response;
});

app.put("/:key{[a-zA-Z0-9]+}", limitBody, async (c) => {
	if (!c.env.ALLOW_MODIFICATION) return c.text("Not found", 404);
	const key = c.req.param("key")!;

	const content = await c.req.arrayBuffer();
	if (content.byteLength === 0) return c.text("Missing content", 400);
	await checkRateLimit(c, c.env.PUT_RATE_LIMITER);

	const authorization = c.req.header("Authorization");
	if (!authorization) return c.text("Authorization header not present", 401);
	if (!authorization.startsWith("Bearer ")) return c.text("Invalid Authorization scheme", 401);

	// Same response for missing and wrong keys, so this endpoint can't be used to probe for content.
	const forbidden = () => c.text("Incorrect modification key", 403);
	const { metadata: entry } = await c.env.INDEX.getWithMetadata<IndexEntry>(key);
	if (!entry || !("r2Path" in entry)) return forbidden();
	const existing = await c.env.CONTENT.head(entry.r2Path);
	const modificationKey = existing?.customMetadata?.modificationKey;
	if (!existing || !modificationKey || !safeEqual(modificationKey, authorization.slice("Bearer ".length))) {
		return forbidden();
	}

	const contentType = boundedHeader(c, "Content-Type") ?? existing.httpMetadata!.contentType!;
	const { body, encoding } = await encodeContent(content, boundedHeader(c, "Content-Encoding"));
	// Keeps the original lifetime on update (upstream recomputes it from the updater's User-Agent), because
	// the R2 prefix and its lifecycle rule are tied to the lifetime the content was created with.
	if (entry.lifetimeMinutes > 0) {
		await c.env.INDEX.put(key, "", { metadata: entry, expirationTtl: entry.lifetimeMinutes * 60 });
	}
	await c.env.CONTENT.put(entry.r2Path, body, {
		httpMetadata: { contentType, contentEncoding: encoding },
		customMetadata: { modificationKey },
	});
	return c.body(null, 200);
});

app.delete("/:key{[a-zA-Z0-9]+}", async (c) => {
	const apiKey = c.req.header("Bytebin-Api-Key");
	if (!apiKey || !splitList(c.env.ADMIN_API_KEYS).includes(apiKey)) return c.text("API key is invalid", 401);

	const key = c.req.param("key");
	const { metadata: entry } = await c.env.INDEX.getWithMetadata<IndexEntry>(key);
	// The R2 object goes before the KV entry that names it, and the purge runs even without an entry, so
	// an interrupted delete can be retried.
	if (entry && "r2Path" in entry) await c.env.CONTENT.delete(entry.r2Path);
	await c.env.INDEX.delete(key);
	await purgeCachedContent(key);
	return entry ? c.body(null, 204) : c.text("Invalid path", 404);
});

export class CachedApp extends WorkerEntrypoint<Bindings> {
	async fetch(request: Request) {
		const response = await app.fetch(request, this.env, this.ctx);
		// Only stored content sets Content-Encoding. Hono rebuilds handler responses (dropping encodeBody),
		// so the already compressed bytes are marked as pre-encoded here, outside Hono.
		if (!response.headers.has("Content-Encoding")) return response;
		return new Response(response.body, { status: response.status, headers: response.headers, encodeBody: "manual" });
	}
}

export default {
	fetch(request, env, ctx) {
		// Deletes purge the cache, and purges are scoped to the entrypoint that issues them.
		const needsCachedApp = ["GET", "HEAD", "DELETE"].includes(request.method);
		if (!needsCachedApp) return app.fetch(request, env, ctx);

		const forwarded = new Request(request);
		forwarded.headers.set("Accept-Encoding", clientAcceptEncoding(request));
		return ctx.exports.CachedApp.fetch(forwarded);
	},
} satisfies ExportedHandler<Bindings>;

async function loadContent(c: AppContext, key: string) {
	await checkRateLimit(c, c.env.GET_RATE_LIMITER);

	const { value, metadata: entry } = await c.env.INDEX.getWithMetadata<IndexEntry>(key, "arrayBuffer");
	if (!entry) return c.text("Invalid path", 404);
	if (!("r2Path" in entry)) {
		const lastModified = new Date(entry.lastModified);
		return serveContent(c, value!, entry.contentType, entry.encoding, lastModified, false, entry.lifetimeMinutes);
	}

	const object = await c.env.CONTENT.get(entry.r2Path);
	if (!object) return c.text("Invalid path", 404);
	return serveContent(
		c,
		object.body,
		object.httpMetadata!.contentType!,
		object.httpMetadata!.contentEncoding!,
		object.uploaded,
		object.customMetadata?.modificationKey !== undefined,
		entry.lifetimeMinutes,
	);
}

async function purgeCachedContent(key: string) {
	// Workers Cache purge only exists on the deployed runtime; wrangler dev has no cache to purge.
	if (typeof cache.purge !== "function") {
		console.warn("Workers Cache purge unavailable, skipping");
		return;
	}
	// Prefixes also match longer keys that start with this one. Evicting those is harmless.
	const result = await cache.purge({ pathPrefixes: [`/${key}`, `/raw/${key}`] });
	if (!result.success) throw new Error(`Cache purge failed: ${JSON.stringify(result.errors)}`);
}

function boundedHeader(c: AppContext, name: string) {
	const value = c.req.header(name);
	if (value && value.length > MAX_HEADER_VALUE_LENGTH) {
		throw new HTTPException(400, { message: `${name} header too long` });
	}
	return value;
}
