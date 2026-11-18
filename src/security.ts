import { HTTPException } from "hono/http-exception";
import type { AppContext } from "./types";

const TOKEN_CHARACTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export async function checkRateLimit(c: AppContext, limiter: RateLimit) {
	let ipAddress = c.req.header("CF-Connecting-IP")!;

	const apiKey = c.req.header("Bytebin-Api-Key");
	if (apiKey) {
		if (!splitList(c.env.RATELIMIT_API_KEYS).includes(apiKey)) {
			throw new HTTPException(401, { message: "API key is invalid" });
		}
		const forwardedIp = c.req.header("Bytebin-Forwarded-For");
		if (!forwardedIp) return;
		ipAddress = forwardedIp;
	}

	const { success } = await limiter.limit({ key: ipAddress });
	if (!success) throw new HTTPException(429, { message: "Rate limit exceeded" });
}

export function generateToken(length: number) {
	let token = "";
	while (token.length < length) {
		for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
			// Reject bytes >= 248 (62 * 4) so the modulo below has no bias.
			if (byte < 248 && token.length < length) token += TOKEN_CHARACTERS[byte % TOKEN_CHARACTERS.length];
		}
	}
	return token;
}

export function safeEqual(a: string, b: string) {
	const encoder = new TextEncoder();
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
}

export function splitList(value?: string) {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}
