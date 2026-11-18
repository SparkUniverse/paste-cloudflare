import type { AppContext } from "./types";

const MAX_CACHE_SECONDS = 604800;
const MODIFIABLE_CACHE_CONTROL = "public, no-cache, proxy-revalidate, no-transform";
// Every distinct Accept-Encoding value is cached as its own variant, so only these encodings are told apart.
const VARIED_ENCODINGS = ["gzip", "br", "zstd", "deflate"];
// q=0 (also q=0.0 up to q=0.000) marks an encoding as refused.
const REFUSED_QUALITY = /;\s*q=0(\.0*)?\s*$/;

export function serveContent(
	c: AppContext,
	body: ReadableStream | ArrayBuffer,
	contentType: string,
	encoding: string,
	lastModified: Date,
	modifiable: boolean,
	lifetimeMinutes: number,
): Response {
	const headers = new Headers({
		"Content-Type": contentType,
		"Last-Modified": lastModified.toUTCString(),
		"Cache-Control": modifiable ? MODIFIABLE_CACHE_CONTROL : immutableCacheControl(lastModified, lifetimeMinutes),
		// Keeps cached raw bytes from being served to browser navigations, which get the paste UI instead,
		// and cached gzip bytes from being served to clients without gzip support.
		Vary: "Sec-Fetch-Dest, Accept-Encoding",
		// User content shares an origin with the paste UI, so it must never render as an active page.
		"Content-Security-Policy": "sandbox",
		"X-Content-Type-Options": "nosniff",
	});

	const storedEncodings = parseContentEncoding(encoding);
	const accepted = new Set(["identity", ...splitAcceptEncoding(c.req.header("Accept-Encoding") ?? "")]);
	if (accepted.has("*") || storedEncodings.every((name) => accepted.has(name))) {
		headers.set("Content-Encoding", encoding);
		return new Response(body, { headers });
	}

	if (storedEncodings.length === 1 && storedEncodings[0] === "gzip") {
		return new Response(new Response(body).body!.pipeThrough(new DecompressionStream("gzip")), { headers });
	}

	return c.text(
		`Accept-Encoding "${c.req.header("Accept-Encoding") ?? ""}" does not contain Content-Encoding "${encoding}"`,
		406,
	);
}

export async function encodeContent(content: ArrayBuffer, contentEncodingHeader?: string) {
	const encodings = parseContentEncoding(contentEncodingHeader);
	if (encodings.length > 0) return { body: content, encoding: encodings.join(",") };

	const gzipped = await new Response(
		new Response(content).body!.pipeThrough(new CompressionStream("gzip")),
	).arrayBuffer();
	return { body: gzipped, encoding: "gzip" };
}

function parseContentEncoding(header?: string) {
	if (!header) return [];
	const encodings = header.split(",").map(normalizeEncoding);
	while (encodings.at(-1) === "identity") encodings.pop();
	return encodings;
}

// The edge rewrites Accept-Encoding before the Worker runs; the client's original value lives on cf.
// Without it the client's support is unknown, so nothing is assumed and gzip content gets decompressed.
// Reduced to a fixed order of known encodings so equivalent values share one cached variant.
export function clientAcceptEncoding(request: Request) {
	const cf = request.cf as IncomingRequestCfProperties | undefined;
	const accepted = new Set(splitAcceptEncoding(cf?.clientAcceptEncoding ?? ""));
	if (accepted.has("*")) return "*";
	return VARIED_ENCODINGS.filter((name) => accepted.has(name)).join(", ");
}

// Content stays cacheable only for as long as its KV entry exists, because nothing purges the cache.
function immutableCacheControl(lastModified: Date, lifetimeMinutes: number) {
	let maxAge = MAX_CACHE_SECONDS;
	if (lifetimeMinutes > 0) {
		const expiresAt = lastModified.getTime() + lifetimeMinutes * 60_000;
		const secondsLeft = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
		maxAge = Math.min(maxAge, secondsLeft);
	}
	return `public, max-age=${maxAge}, no-transform, immutable`;
}

function splitAcceptEncoding(header: string) {
	return header
		.toLowerCase()
		.split(",")
		.filter((part) => part.trim() && !REFUSED_QUALITY.test(part))
		.map((part) => normalizeEncoding(part.split(";")[0]));
}

function normalizeEncoding(name: string) {
	const normalized = name.trim().toLowerCase();
	return normalized === "x-gzip" ? "gzip" : normalized;
}
