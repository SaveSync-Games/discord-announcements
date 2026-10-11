# Steam announcements to Discord

Every 15 minutes a GitHub Action reads the Steam news feeds in `feeds.json` and posts anything new to Discord with `@everyone`.

`posted.json` is the record of what has gone out, per channel. A post whose `guid` is listed under a channel is never sent to that channel again. The first time a channel is seen, every existing post is recorded with `postedAt: null` and nothing is sent, so the backlog doesn't flood it.

## Setup

Add repo secrets (Settings → Secrets and variables → Actions):

| Secret | Channel | Gets |
|---|---|---|
| `DISCORD_WEBHOOK_SAVESYNC_ANNOUNCEMENTS` | SaveSync server, announcements | SaveSync posts |
| `DISCORD_WEBHOOK_SERVERSYNC_ANNOUNCEMENTS` | ServerSync server, announcements | ServerSync posts |
| `DISCORD_WEBHOOK_SERVERSYNC_WIP` | SaveSync server, ServerSync WIP | ServerSync posts |

## Testing

- Actions → Steam announcements → Run workflow with `dry_run` ticked prints the payload without sending.
- To resend a real post, delete its entry from `posted.json`, commit, and run the workflow.

Locally:

```bash
node announce.mjs --dry-run
```

## Adding a game

Add an entry to `feeds.json` with the app's RSS URL and one `targets` entry per channel, then add each target's `webhookEnv` as a secret and to the workflow's `env`.
