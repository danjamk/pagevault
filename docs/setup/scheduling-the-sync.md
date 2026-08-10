# Scheduling the sync

Views reach Analytics Engine on their own. Getting them *out* is the part nobody does for you.

Analytics Engine is a conveyor belt about 90 days long. `pagevault sync-views` is the only thing
that takes boxes off it and into your deployment, where they stay for good. **Miss it for 90 days
and that window is gone — nothing errors, nothing looks wrong, and the data is simply never there
later.** There is no backfill, from Cloudflare or from anyone.

So: run it on a schedule. Daily is the right cadence — it costs one KV write against a 1000/day
budget, and it means a missed run is a missed day rather than a missed quarter.

```bash
pagevault sync-views
```

`pagevault health` tells you where you stand, including how much runway is left:

```
✓ View history captured through 2026-08-09 — 90 days of runway.
```

---

## Which scheduler

| You are on | Use | Why |
|---|---|---|
| **a Mac** | launchd | It runs a missed job when the machine wakes. cron just skips it, silently — and a laptop is asleep at 3am. |
| **an always-on Linux box** | a systemd timer | Same reason inverted: the machine is never asleep, and `systemctl status` tells you whether it ran. Plain cron is fine if the box has no systemd. |
| **a deployment CI deploys** | a scheduled GitHub Action | The Cloudflare credential is already there and not on your laptop. This is what PageVault's own production uses. |

Pick one. Running two is not safer — two syncs inside KV's ~60s consistency window can race, and the
loser's contribution is dropped until the next run.

---

## Before any of them: the two things that break these jobs

**1. `node` will not be on the PATH.** This is the failure, not a footnote. The `pagevault` command
is a script starting `#!/usr/bin/env node`, and cron and launchd run with a minimal environment — so
even the full path to `pagevault` fails with `env: node: No such file or directory`. Find the
directory to add:

```bash
dirname "$(which node)"
```

Every snippet below puts that on the PATH. If you use a Node version manager, this path changes when
you switch versions, and the job stops running the day you do.

**2. Your state has to be reachable.** If you installed with `npm install -g pagevault` and ran
`pagevault init`, everything lives in `~/.pagevault/` and the job works from any directory as long as
`HOME` is set. If you run from a repo checkout instead, the state is in that checkout — so the job
has to `cd` there first.

---

## macOS — launchd

`~/Library/LaunchAgents/com.pagevault.sync-views.plist`, with both paths replaced by yours:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pagevault.sync-views</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/YOU/.nvm/versions/node/v22.22.3/bin/pagevault</string>
    <string>sync-views</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/Users/YOU/.nvm/versions/node/v22.22.3/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>17</integer></dict>
  <key>StandardOutPath</key><string>/tmp/pagevault-sync.log</string>
  <key>StandardErrorPath</key><string>/tmp/pagevault-sync.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.pagevault.sync-views.plist
launchctl start com.pagevault.sync-views   # run it once now, to prove it works
cat /tmp/pagevault-sync.log
```

Run it once by hand like that before trusting it. A scheduled job that has never run successfully is
indistinguishable from one that runs every night.

## Linux — a systemd timer

`~/.config/systemd/user/pagevault-sync.service`:

```ini
[Unit]
Description=Promote PageVault view history

[Service]
Type=oneshot
Environment=PATH=/home/YOU/.nvm/versions/node/v22.22.3/bin:/usr/bin:/bin
ExecStart=/home/YOU/.nvm/versions/node/v22.22.3/bin/pagevault sync-views
```

`~/.config/systemd/user/pagevault-sync.timer`:

```ini
[Unit]
Description=Daily PageVault view sync

[Timer]
OnCalendar=*-*-* 03:17:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl --user enable --now pagevault-sync.timer
systemctl --user start pagevault-sync.service   # prove it works
journalctl --user -u pagevault-sync.service -n 20
loginctl enable-linger "$USER"                  # so it runs when you are not logged in
```

`Persistent=true` is what makes a missed run happen on next boot. Without it a powered-off machine
behaves like cron.

**Plain cron**, if the box has no systemd — note the explicit `PATH`, which is the whole trick:

```cron
PATH=/home/YOU/.nvm/versions/node/v22.22.3/bin:/usr/bin:/bin
17 3 * * * pagevault sync-views >> /tmp/pagevault-sync.log 2>&1
```

## CI — a scheduled GitHub Action

Right when the deployment is deployed by CI, because the Cloudflare credential is already there and
deliberately not on your laptop. PageVault's own production runs
[`.github/workflows/sync-views-prod.yml`](../../.github/workflows/sync-views-prod.yml) — a worked
example you can copy, including the two-secret split (an analytics-read token, and the deployment
bearer) and a Slack heartbeat so a job that silently stops running is visible.

Two things it does that are worth keeping: a schedule at an odd minute, because GitHub's scheduler is
busiest on the hour and drops jobs under load; and a heartbeat on *every* successful run, not only on
change — a scheduled job that quietly stops is the same shape of failure one level up as the one this
whole page exists to prevent.

This is not the general answer. Most operators install from npm and have no CI, which is why it is
last here rather than first.

---

## Checking it is actually working

```bash
pagevault health
```

That reports the runway, and says so loudly when history is at risk or already lost. It is also what
to check a week after setting any of this up — the point at which a job that never ran will have
said nothing at all.

If you would rather see the numbers than the runway:

```bash
pagevault views --by day
```

---

## See also

- [`cli-reference.md`](cli-reference.md) — `views` and `sync-views` in full.
- [ADR-023](../adr/ADR-023-the-summary-is-the-history.md) — why the summary accumulates, and the
  90-day invariant this page exists to protect.
