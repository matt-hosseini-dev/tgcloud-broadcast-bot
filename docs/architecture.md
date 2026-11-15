# Architecture

## Platform constraints that shape the code

Telegram Serverless runs each handler in a V8 isolate. Inside it there is no
filesystem, no npm packages and no environment variables; only the `sdk` module
(`api`, `db`, `fetch`) and the project's own modules under `tgcloud/`. Each update is a
separate invocation, including each item of an album. There are no timers, cron or
queues to rely on, and the `sdk` cannot be imported outside the platform.

That gives four rules:

1. **State lives in the database.** Drafts, channels, broadcasters and delivery results
   are rows, not memory.
2. **Concurrency is settled by SQL.** Each `db.run` statement is atomic. Races (album
   items, double taps) are decided by unique constraints and conditional `UPDATE`s
   checked through `rowsAffected`.
3. **Only one module imports `sdk`.** `tgcloud/lib/container.js` builds the
   dependencies `{ api, db, config, now, sleep }`; every other module takes them as an
   argument. That is what makes the code testable in plain Node.
4. **Per-deployment values are generated.** `scripts/write-config.mjs` writes the
   git-ignored `tgcloud/lib/config.js` from `OWNER_IDS`.

## Layout

```
tgcloud/
  schema.js               tables (platform schema DSL)
  handlers/               one line each: createDeps() -> router
    message.js  callback_query.js  my_chat_member.js
  lib/
    container.js          the only importer of 'sdk' and config.js
    router.js             dedupe, role check, command/button parsing and dispatch
    auth.js               owner (config) / broadcaster (db) / none
    drafts.js             collecting messages, control message, cancel
    broadcast.js          fan-out, classification, 429 retry, report, Retry failed
    report.js             user-facing texts and keyboards
    channels.js           /addchannel, /channels, my_chat_member registration
    broadcasters.js       /addbroadcaster, /broadcasters
    store.js              all SQL
scripts/write-config.mjs  OWNER_IDS -> tgcloud/lib/config.js
test/                     node:test suites and helpers
```

## Flows

### Drafting

Every message from an owner or broadcaster that is not a known command goes into the
sender's open draft.

`drafts.open_key` holds the user id while a draft is open and `NULL` afterwards. Its
`UNIQUE` constraint allows one open draft per user. Each invocation runs
`INSERT … ON CONFLICT(open_key) DO NOTHING` and then reads the open draft. Exactly one
insert wins; only that invocation sends the control message with **Publish** and
**Cancel**. If sending it fails, the draft is closed so the next message starts over.

The message itself is inserted with `INSERT … SELECT … WHERE EXISTS (draft is open)`.
If Publish claimed the draft in between, the insert does nothing and the message goes
into a fresh draft instead of being lost. An open draft with no new message for an
hour is cancelled (its control message says so) when the next message arrives.

### Publishing

1. **Claim.** `UPDATE drafts SET status = 'publishing', open_key = NULL WHERE id = ? AND
user_id = ? AND status = 'open'`. If no row changed, someone already published or
   cancelled, so a double tap does nothing.
2. **Answer the button** right away. The fan-out can take seconds and callback queries
   expire.
3. **Fan out.** Every channel gets a `pending` delivery row first, and the control
   message shows "Publishing…" with a **Retry failed** button for recovery. Then, for
   each enabled channel, concurrently (`Promise.allSettled`):
   `copyMessages({ chat_id, from_chat_id, message_ids })` with ids ascending, in chunks
   of 100. Each result is stored as soon as that channel settles.
4. **Classify** each channel as:
   - **sent**: every message was copied.
   - **partial**: fewer copies than requested. Telegram silently skips messages it
     cannot copy.
   - **failed**: the call threw; the Bot API `description` is stored.

   A 429 with `retry_after` ≤ 5 s is waited out once. If the runtime has no
   `setTimeout`, it is reported instead.

5. **Report.** The control message is edited into the per-channel report. It gets
   **Retry failed** if anything failed or never finished. If the edit fails, a new
   message is sent. The report runs in a `finally`, so an error mid-way still produces
   one.

### Retry failed

Each retry run claims rows by setting their status to its own token
(`retrying:<random>`) and then selects exactly those rows. Claimable rows are `failed`
ones, plus `pending` or `retrying:*` rows untouched for two minutes, which were left
behind by an interrupted run. Overlapping taps therefore never send to the same channel
twice, and a crashed publish can be finished later. Channels removed since then are
marked **skipped**.

### Channels joining

`my_chat_member` fires when the bot's status in a chat changes. A channel is
registered only if the change was made by an owner and the bot can post. A stranger
who adds the bot to their channel achieves nothing.

### Dedupe

Each handler first inserts `update_id` into `processed_updates`. If the row already
existed, the update is skipped. Rows older than seven days are pruned now and then.

## Tables

| Table               | Purpose                                                             |
| ------------------- | ------------------------------------------------------------------- |
| `processed_updates` | update ids already handled                                          |
| `broadcasters`      | users allowed to publish (owners come from config)                  |
| `channels`          | destinations                                                        |
| `drafts`            | a post being collected; `open_key` enforces one open draft per user |
| `draft_messages`    | message ids in a draft                                              |
| `broadcasts`        | one publish of a draft (`message_ids` JSON)                         |
| `deliveries`        | result per channel per broadcast                                    |
| `pending_actions`   | `/addbroadcaster` waiting for a forwarded message                   |

There are no foreign keys; the platform does not support them.
