# tgcloud-broadcast-bot

A Telegram bot that publishes one post to many channels, groups and users at once
and reports what happened for each. It runs on
[Telegram Serverless](https://core.telegram.org/bots/serverless) (`tgcloud`), so there
is no server to host.

Send the bot a post in private chat: text, photo, video, document or an album. Tap
**Publish** to get a checklist of your targets, all ticked. Untick any, then tap
**Send**. The bot edits its message into a report per target, and **Retry** resends to
the ones that failed.

```
📣 Sent 2/3

✅ 📢 Daily News
✅ 👥 Team
❌ Archive: Forbidden: bot is not a member of the channel chat
              [ 🔁 Retry ]
```

## Features

- **Native pickers for owners.** A keyboard with 👤 User, 👥 Group and 📢 Channel opens
  Telegram's own chat picker. The bot checks it can post there and saves the target.
  📋 Targets lists them with remove buttons.
- **Per-post checklist.** Publish shows every target ticked; untick the ones this post
  should skip.
- **Drafts.** Everything you send goes into a draft until you send or cancel it. A
  10-photo album gets one control message, not ten. A draft idle for an hour is
  discarded on your next message.
- **`copyMessages`.** Formatting, captions and albums survive, and posts appear without
  a "Forwarded from" header.
- **Safe against double taps and redelivery.** Send and Retry claim their work
  atomically, and every update is processed once. If a send is interrupted, **Retry**
  picks up the targets it did not finish.
- **Roles.** Owners (set per deployment) manage targets and broadcasters. Broadcasters
  publish. Everyone else is ignored.
- **Channels and groups register themselves** when an owner adds the bot to them.

## Targets

| Type    | How to add                                                         | Requirement                                   |
| ------- | ------------------------------------------------------------------ | --------------------------------------------- |
| Channel | 📢 Channel, `/add @channel`, or make the bot an admin              | Bot is admin with **Post messages**           |
| Group   | 👥 Group (lists groups the bot is in), `/add <id>`, or add the bot | Bot is a member allowed to send messages      |
| User    | 👤 User (up to 10 at a time)                                       | The user has started the bot (flagged if not) |

## Commands

The owner keyboard appears after `/start`.

| Command                                   | Who                  | What it does                                    |
| ----------------------------------------- | -------------------- | ----------------------------------------------- |
| `/start`, `/help`                         | owners, broadcasters | Short help; owners also get the picker keyboard |
| `/cancel`                                 | owners, broadcasters | Discard the current draft                       |
| 📋 Targets or `/targets`                  | owners               | List targets, with remove buttons               |
| `/add <@username or id>`                  | owners               | Add a channel or group                          |
| `/broadcasters`                           | owners               | List broadcasters, with remove buttons          |
| `/addbroadcaster <user id>`               | owners               | Allow someone to publish                        |
| `/addbroadcaster`, then forward a message | owners               | Same, when you do not know their id             |

Any other message from an owner or broadcaster becomes part of their draft.

## Deploy your own

You need Node.js 22.15 or newer and a Telegram account.

1. **Create a bot.** In [@BotFather](https://t.me/BotFather) send `/newbot`. Then open
   your bot in BotFather → **Serverless** → **CLI Access** and copy the access token.
   This token is for the `tgcloud` CLI and is not the bot's API token.
2. **Get the code.**
   ```sh
   git clone https://github.com/<you>/tgcloud-broadcast-bot.git
   cd tgcloud-broadcast-bot
   npm install
   ```
3. **Set the owners.** Copy `.env.example` to `.env` and put the Telegram user ids of
   the owners in `OWNER_IDS` (comma separated; [@userinfobot](https://t.me/userinfobot)
   tells you yours). `.env` is git-ignored.
4. **Link the project to your bot.** `npx tgcloud login` and paste the CLI access token.
5. **Deploy and create the tables.**
   ```sh
   npm run deploy        # writes tgcloud/lib/config.js from OWNER_IDS, then tgcloud push
   npx tgcloud migrate   # applies tgcloud/schema.js to the bot's database
   ```
6. **Add targets.** Send `/start` and use 👤 👥 📢 on the keyboard. Adding the bot to a
   channel (as admin with **Post messages**) or a group also registers it.
7. **Add broadcasters** (optional). Owners can always publish; `/addbroadcaster` lets
   others publish too.

### Continuous deployment with GitHub Actions

`.github/workflows/deploy.yml` deploys every push to `main`. In your repository create
an environment named `production` and add two **secrets** to it:

| Secret          | Value                                     |
| --------------- | ----------------------------------------- |
| `TGCLOUD_TOKEN` | The CLI access token from step 1          |
| `OWNER_IDS`     | The same comma-separated ids as in `.env` |

The workflow runs the checks, generates the config, then runs `tgcloud fetch`, `push`,
`migrate --safe` (safe changes only; `--safe` and `--yes` cannot be combined) and `webhook sync`. Without `TGCLOUD_TOKEN` it skips itself, so
forks do not fail.

## Privacy

Owner ids are per-deployment values. They live in `.env` locally and in a GitHub
secret in CI, and are compiled into `tgcloud/lib/config.js`, which is git-ignored. They
are never committed. Telegram Serverless has no environment variables, so this
generated module is how they reach the bot.

## Limits

- `copyMessages` cannot copy some messages (paid media, polls, invoices, giveaways…).
  Those are skipped and the channel is reported as **partial** with the count copied.
- Only channels are accepted as destinations, not groups.
- A 429 (flood limit) with a short `retry_after` (≤ 5 s) is retried once. Longer waits
  are reported as failures; use **Retry** later.
- Telegram Serverless is in beta and does not document handler time limits. A handful
  of channels is fine. Very long channel lists have not been tested.
- If a handler fails after an update was recorded, Telegram's redelivery of that
  update is ignored. This trades a rare lost draft message for never publishing twice.

## Documentation

- [docs/architecture.md](docs/architecture.md): how the code is organised and why
- [docs/development.md](docs/development.md): tests, linting, running against a test bot
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [docs/tgcloud-sdk.md](docs/tgcloud-sdk.md): the platform SDK reference, from the `tgcloud` scaffold

## License

[MIT](LICENSE)
