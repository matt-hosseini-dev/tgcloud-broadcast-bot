# tgcloud-broadcast-bot

A Telegram bot that publishes one post to many channels at once and reports what
happened in each. It runs on [Telegram Serverless](https://core.telegram.org/bots/serverless)
(`tgcloud`), so there is no server to host.

Send the bot a post in private chat: text, photo, video, document or an album. Press
**Publish** and it is copied to every channel, albums kept together. The bot then edits
its message into a report per channel. If a channel failed, **Retry failed** sends it
there again and nowhere else.

```
📣 Sent to 2 of 3 channels.

✅ Daily News
✅ Weekly Digest
❌ Archive: Forbidden: bot is not a member of the channel chat
                    [ 🔁 Retry failed ]
```

## Features

- **Drafts with Publish / Cancel.** Everything you send goes into a draft until you
  publish or cancel it. A 10-photo album gets one control message, not ten.
  A draft left untouched for an hour is discarded on your next message, which starts a
  new one.
- **One call per channel.** Uses `copyMessages`, so formatting, captions and albums
  survive, and posts appear without a "Forwarded from" header.
- **Per-channel report** with the Bot API's own error text, and a retry button that
  only targets failed channels.
- **Safe against double taps and redelivery.** Publish and Retry claim their work
  atomically in the database, and every update is processed once. If a publish is interrupted,
  **Retry failed** picks up the channels it did not finish.
- **Roles.** Owners (set per deployment) manage channels and broadcasters. Broadcasters
  publish. Everyone else is ignored.
- **Channels register themselves** when an owner makes the bot a channel admin.

## Commands

| Command                                   | Who                  | What it does                                        |
| ----------------------------------------- | -------------------- | --------------------------------------------------- |
| `/start`, `/help`                         | owners, broadcasters | Show help for your role                             |
| `/cancel`                                 | owners, broadcasters | Discard the current draft                           |
| `/channels`                               | owners               | List channels, with remove buttons                  |
| `/addchannel <@username or id>`           | owners               | Add a channel after checking the bot can post there |
| `/broadcasters`                           | owners               | List broadcasters, with remove buttons              |
| `/addbroadcaster <user id>`               | owners               | Allow someone to publish                            |
| `/addbroadcaster`, then forward a message | owners               | Same, when you do not know their id                 |

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
6. **Add channels.** Make the bot an admin of each channel with the **Post messages**
   right. If an owner does that, the channel is registered automatically. Otherwise an
   owner sends `/addchannel @channelname`.
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
  are reported as failures; use **Retry failed** later.
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
