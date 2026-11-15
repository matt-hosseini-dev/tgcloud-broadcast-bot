# Contributing

Thanks for helping. Bug reports, fixes and small features are welcome.

1. Open an issue first for anything larger than a fix, so we can agree on the approach.
2. Fork, then create a branch named after the change (`fix/report-length`,
   `feat/schedule`).
3. Write a failing test first, then the code. See [docs/development.md](docs/development.md)
   for how tests run without the platform.
4. `npm run check` must pass.
5. Keep commits small and use [Conventional Commits](https://www.conventionalcommits.org/)
   (`feat:`, `fix:`, `docs:`, `test:`, `ci:`, `chore:`).
6. Open a pull request describing what changed and how you tested it. Mention whether you
   tried it on a test bot.

Never commit tokens, `.env`, `tgcloud/lib/config.js` or real Telegram user ids.
