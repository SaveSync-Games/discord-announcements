# Steam announcements to Discord

Every 15 minutes a GitHub Action reads the Steam news feeds in `feeds.json` and posts anything new to Discord with `@everyone`.

`posted.json` is the record of what has gone out. A post whose `guid` is in it is never sent again. On the very first run for a game, every existing post is recorded with `postedAt: null` and nothing is sent, so the backlog doesn't flood the channel.

## Setup

Add repo secrets (Settings → Secrets and variables → Actions):

| Secret | Used for |
|---|---|
| `DISCORD_WEBHOOK_SAVESYNC` | SaveSync posts |
| `DISCORD_WEBHOOK_SERVERSYNC` | ServerSync posts |
| `DISCORD_WEBHOOK_URL` | Fallback for any game without its own secret |

## Testing

- Actions → Steam announcements → Run workflow with `dry_run` ticked prints the payload without sending.
- To resend a real post, delete its entry from `posted.json`, commit, and run the workflow.

Locally:

```bash
node announce.mjs --dry-run
```

## Adding a game

Add an entry to `feeds.json` with the app's RSS URL and a `webhookEnv` name, then add that secret.
