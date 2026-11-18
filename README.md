# paste-cloudflare

A port of [lucko/bytebin](https://github.com/lucko/bytebin) and [lucko/paste](https://github.com/lucko/paste) to Cloudflare Workers, using Hono, KV and R2. The HTTP API is the same as upstream, except that `POST /admin/bulkdelete` is replaced by `DELETE /{key}`, which takes one of the `ADMIN_API_KEYS` in the `Bytebin-Api-Key` header.

KV holds the index and expires content by TTL. Small, short lived content lives in KV directly, everything else in R2 under a prefix named after its lifetime (`forever/`, `1440m/`).

The UI is the `paste/` submodule, built into `public/`. `patches/branding.patch` is applied during the build and reverted afterwards.

To change the branding, run `git apply ../patches/branding.patch` in `paste/`, edit, then regenerate the patch with `git diff --binary > ../patches/branding.patch` and `git checkout -- .`. To update paste, check out a newer commit in `paste/`, run `pnpm run build:paste` to confirm the patch still applies, and commit the submodule change.

## Setup

```sh
git submodule update --init
sfw pnpm install --frozen-lockfile --ignore-scripts
pnpm exec wrangler kv namespace create bytebin-index   # put the id in wrangler.jsonc
pnpm exec wrangler r2 bucket create bytebin
pnpm exec wrangler secret put RATELIMIT_API_KEYS
pnpm exec wrangler secret put ADMIN_API_KEYS
pnpm run deploy
```

Each lifetime in `DEFAULT_LIFETIME_MINUTES` or `LIFETIME_OVERRIDES_MINUTES` needs an R2 lifecycle rule on its prefix, with `--expire-days` set to the lifetime rounded up to whole days, or expired blobs stay in R2:

```sh
pnpm exec wrangler r2 bucket lifecycle add bytebin expire-129600m 129600m/ --expire-days 90
```
