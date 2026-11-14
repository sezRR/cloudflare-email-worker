# Legacy: Cloudflare Worker version

**Not in use.** This is the original email labeller, kept for reference. The version that runs
is the Node app at the repository root.

It was replaced because it reaches Gmail through the REST API with an OAuth refresh token, and
the Google OAuth app behind it is in "Testing": Google expires such tokens seven days after
consent, so the Worker needed a new token minted by hand every week. App passwords do not work
with the REST API, so the fix was a move to IMAP rather than a change of credential.

Everything here still works from this folder (Hono routes, hourly cron trigger, D1 through
Drizzle):

```sh
cd cloudflare-worker
pnpm install
npx wrangler dev
npx wrangler deploy
```

If the Worker is still deployed, remove it (`npx wrangler delete`) or drop its cron trigger so
it does not label the same mail as the new app or log a failed run every hour.

See `AGENTS.md` in this folder for the Cloudflare-specific notes.
