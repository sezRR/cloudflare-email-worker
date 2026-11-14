# Email labeller

Sorts new Gmail inbox mail into the labels you already made. Once an hour it reads what
arrived since the last run, asks TypeSafe which label fits each email, and adds that label
when the answer is confident enough.

It signs in to Gmail over IMAP with an **app password**, runs as a one-shot Docker container,
and is started by the host's cron.

> The earlier Cloudflare Worker version lives in [`cloudflare-worker/`](cloudflare-worker/README.md).
> It is kept for reference and is not what runs.

## Layout

| Path | What |
|---|---|
| `src/main.ts` | Entry point: one run, exit code 1 on failure |
| `src/labeller.ts` | Classification, confidence gate, label descriptions |
| `src/gmail.ts` | IMAP client (`imapflow`): list labels, fetch new mail, add labels |
| `src/state.ts` | Inbox cursor, kept in a JSON file |
| `src/config.ts` | Environment variables |
| `cloudflare-worker/` | Legacy Worker (OAuth + Gmail REST + D1) |

## Gmail setup (once)

1. Turn on 2-Step Verification for the Google account.
2. Create an app password at <https://myaccount.google.com/apppasswords>.
3. Gmail → Settings → Labels: tick **Show in IMAP** for every label mail should be sorted into.
   Labels hidden from IMAP are invisible to the labeller.
4. Gmail → Settings → Forwarding and POP/IMAP: folder size limit on **Do not limit**.

The app password does not expire, but Google revokes it when the account password changes.
It gives full access to the mailbox, so keep `.env` private.

## Deploy on the VPS

```sh
git clone <this repo> /opt/email-labeller && cd /opt/email-labeller
cp .env.example .env && chmod 600 .env   # then fill it in
docker compose build
docker compose run --rm labeller         # first run: judges the newest 50 emails
```

Then schedule it:

```sh
make cron-set      # hourly; replaces its own entry, safe to re-run
make cron-list     # show the crontab
make cron-remove
```

That installs:

```cron
0 * * * * cd /opt/email-labeller && docker compose run --rm labeller >> /var/log/email-labeller.log 2>&1
```

The schedule is `CRON_SCHEDULE` in `.env`; run `make cron-set` again after changing it.
One-off overrides: `make cron-set SCHEDULE='*/15 * * * *' LOG=/path/to.log`.

To update: `make deploy` (`git pull --ff-only && docker compose build`).

The cursor is stored in the `labeller-data` Docker volume. Removing that volume makes the next
run a full sync (newest 50 emails again; labels are only ever added, so nothing is lost).

## Local development

Needs Node 24+ and pnpm.

```sh
pnpm install
pnpm test
pnpm typecheck
STATE_PATH=./data/state.json pnpm start   # reads .env
```

## Output

```
+ aposto  (0.93) Aposto Gündem <team@aposto.com> — …   label added
? medium  (0.31) …                                      below the confidence gate, not labelled
. none    (0.88) …                                      no label fits
```
