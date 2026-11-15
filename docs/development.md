# Development

## Setup

```sh
npm install
cp .env.example .env    # set OWNER_IDS
```

Node.js 22.15 or newer is required (the tests use `node:sqlite` and
`module.registerHooks`).

## Checks

```sh
npm test               # node:test, all suites
npm run lint           # eslint
npm run format:check   # prettier (npm run format to fix)
npm run check          # all three, as CI runs them
```

## How the tests run without the platform

- `test/helpers/register.js` is loaded with `node --import`. It maps `sdk` to
  `fake-sdk.js` and `sdk/db` to `fake-sdk-db.js`. It also maps the generated
  `tgcloud/lib/config.js` to `test-config.js` (owners `1` and `2`).
- `test/helpers/sqlite-db.js` exposes the platform's raw-SQL surface (`db.run`,
  `db.all`, `db.get` with `:named` params) over an in-memory `node:sqlite` database built
  from `test/helpers/schema.sql`. Every call is async, so concurrent callers interleave
  the way separate invocations would.
- `test/helpers/fake-api.js` records Bot API calls and lets a test script results or
  failures per method (`api.on`, `api.fail`).
- Unit tests call `lib/` modules with dependencies from `test/helpers/deps.js`.
  `test/handlers.test.js` runs the real handler files end to end.

### Schema changes

`tgcloud/schema.js` uses the platform's schema DSL and only runs on the platform.
`test/helpers/schema.sql` mirrors it for tests. `test/schema.test.js` fails if their
tables or columns differ. Before deploying, also check the real migration:

```sh
npx tgcloud migrate --dry-run --local
```

Drops only happen through `.deprecated()`. Never delete a declaration expecting it to
drop.

## Trying it on a test bot

Use a separate bot for development. `npx tgcloud run` executes code on the platform
with real side effects.

```sh
npx tgcloud login                 # CLI access token of the test bot
npm run deploy && npx tgcloud migrate
npx tgcloud status                # local vs deployed
npx tgcloud webhook               # webhook in sync with handlers?

# A message from a stranger: expect no reply
npx tgcloud run handlers/message '{ message_id: 1, from: { id: 1 }, chat: { id: 1, type: "private" }, text: "/start" }' --ctx '{ update: { update_id: 1 } }'
```

Then, with two throwaway channels where the test bot is admin:

1. `/start`, then add targets with 👤 👥 📢. Send text with formatting, a photo with a
   caption, a 3-photo album and a document; Publish, untick one target, Send.
2. Remove the bot's **Post messages** right in one channel and publish again. The
   report should show the failure and **Retry**. Restore the right and press it.

## Conventions

- Plain JavaScript (ES modules) with JSDoc, no build step.
- Relative imports under `tgcloud/` end in `.js`; the platform requires it.
- Only `lib/container.js` imports `sdk`. Every other module takes its dependencies as
  arguments.
- All SQL goes in `lib/store.js`.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/).
