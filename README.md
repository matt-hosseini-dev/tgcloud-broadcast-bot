# tgcloud-broadcast-bot

Send one post to many Telegram channels, groups and users at once, and see what
happened in each. Runs on [Telegram Serverless](https://core.telegram.org/bots/serverless):
no server to host.

```
📣 Sent 2/3

✅ 📢 Daily News
✅ 👥 Team
❌ Archive: Forbidden: bot is not a member of the channel chat
              [ 🔁 Retry ]
```

## Quick start

You need [Node.js](https://nodejs.org) 22.15+ and a Telegram bot.

1. In [@BotFather](https://t.me/BotFather): `/newbot`, then open the bot →
   **Serverless** → **CLI Access** and copy the access token.
2. Run:

   ```sh
   git clone https://github.com/matt-hosseini-dev/tgcloud-broadcast-bot.git
   cd tgcloud-broadcast-bot
   npm run setup
   ```

   It asks for the owners' Telegram user ids ([@userinfobot](https://t.me/userinfobot)
   shows yours) and the access token, then deploys. Run it again any time to change
   owners or redeploy.

3. Open your bot in Telegram and send `/start`.

## How to use it

1. **Add targets** with the keyboard under the message box (owners only):
   - 📢 **Channel**: pick a channel; the bot needs admin with **Post messages**.
   - 👥 **Group**: pick a group the bot is in.
   - 👤 **User**: pick people; they must have pressed Start on the bot.
   - 📋 **Targets**: see the list and remove targets.
2. **Send a post** to the bot: text, photo, video, file or an album.
3. Tap **Publish**, untick any targets to skip, then tap **📤 Send**.
4. Read the report. **🔁 Retry** resends only to the targets that failed.

Adding the bot to a channel or group as an owner also adds it as a target.

| Command                     | What it does                                  |
| --------------------------- | --------------------------------------------- |
| `/cancel`                   | Discard the current draft                     |
| `/add <@username or id>`    | Add a channel or group by name (owners)       |
| `/broadcasters`             | List people who can post, with remove buttons |
| `/addbroadcaster <user id>` | Let someone else post (owners)                |

Owners can do everything. Broadcasters can only post. Everyone else is ignored.

## Limits

- Polls, paid media, invoices and giveaways can't be copied; those targets show as ⚠️.
- Telegram's flood limit: short waits are retried once, longer ones show as failed.
  Tap Retry later.

## More

- [docs/architecture.md](docs/architecture.md): how it works
- [docs/development.md](docs/development.md): tests, GitHub Actions deploy, test bot
- [CONTRIBUTING.md](CONTRIBUTING.md)

## License

[MIT](LICENSE)
