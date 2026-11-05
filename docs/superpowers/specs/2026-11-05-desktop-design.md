# Project B: desktop experience

For macOS 12 Intel and Fedora GNOME. No sharing, no native documents, no Finder badges.

## What the user asked for

- System notification and menu bar icon for conflicts, held deletions, expired session, stopped sync.
- Icon shows state and transfers in progress. `status` is readable.
- An indicator of files newly sent to the trash or quarantine since last read. Restoring stays on the Drive.
- Pause and resume. Custom exclusions.
- Start at login, a setup assistant, updates: automatic if CI is green, otherwise only signalled.

## Design (author's calls)

The daemon writes `desktop.json` atomically in its data folder: a rendered view (level, title, lines), a heartbeat and
counters. It sends notifications on transitions only. The icons are thin: they read that file, run `proton-sync`
commands from their menu, and treat a heartbeat older than 3 minutes as "sync stopped", which a dead daemon cannot
report itself.
- All text shown to the user is in English.

- macOS: one Swift file, built locally with `swiftc`.
- Linux: one Python file with Ayatana AppIndicator. GNOME needs the AppIndicator extension to show any tray icon.
- Pause: a `paused` file. The daemon checks it before each pass and is woken with SIGUSR1.
- Exclusions: `exclude` in the config, name patterns with `*` and `?`, trailing `/` for folders. Applied on both
  sides, so excluded items are forgotten by the sync and left where they are, never deleted.
- Stale notifications are avoided by comparing the previous state with the new one in a pure function.

Delivered in order: core and commands, icons, setup and start at login, updates.
