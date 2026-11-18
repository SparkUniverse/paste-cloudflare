import type { Context } from "hono";

export type Bindings = Env & {
	RATELIMIT_API_KEYS?: string;
	ADMIN_API_KEYS?: string;
};

export type AppContext = Context<{ Bindings: Bindings }>;
