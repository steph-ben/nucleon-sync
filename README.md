# proton-sync

**Status: tested against the real service in an isolated space, between two folders on the same Mac. Not yet tested on Linux or on "My files".**

Two-way sync daemon between `~/Proton` and Proton Drive, for macOS 12 Intel and Linux.
It replaces `rclone bisync`. Detailed design: `docs/design.md`.

Personal, unofficial client built on the Proton Drive SDK. Not affiliated with Proton.
It identifies itself to Proton as `external-drive-protonsync`.

Proton limits for device spaces, hence the mandatory subfolder when testing: no files at the root, and no renaming or moving of top-level folders by any client other than the desktop app.

## Installation

Prerequisites: bun and npm. The repository is expected in `~/dev/proton-sync`.

    cd ~/dev/proton-sync
    scripts/install.sh

The script installs the dependencies, applies `scripts/patch-crypto.sh`, creates the
`~/.local/bin/proton-sync` link and copies the service file (launchd on macOS, systemd on Linux).
It does not start anything: it prints the command to run. It is safe to run again.

Then:

    proton-sync login
    proton-sync init <folder> <device:name/folder|root>
    proton-sync plan

To switch from rclone to proton-sync, follow `docs/migration.md`. On Linux, start with `docs/linux-install.md`.

## Continuous integration

GitHub Actions (`.github/workflows/ci.yml`, ubuntu only, bun 1.4.2) runs on every push to `main` and every pull request: the tests (`local`, `scenarios`, `integration`, `proton-adapter`, `journal`), the fuzz test, then `tsc --noEmit`, which fails on any error in `src/` or `test/`.
No access to Proton, the keychain or the network is needed. To reproduce locally, run the commands in `CLAUDE.md` (Commands section).

## Commands

- `init <folder> <device:name/folder|root>`: writes the configuration.
- `login` / `logout`: sign in to and out of Proton.
- `plan`: shows what would be done, without changing anything.
- `once`: a single sync pass.
- `run`: daemon, continuous sync.
- `approve`: approves the large deletions that were held back.
- `status`: state of the last pass.
- `version`: version.

## Configuration

`config.json` file, in `~/.local/share/proton-sync` by default. `proton-sync init` writes it, except `allowDriveRoot`, which must be added by hand.

| Option | Required | Purpose |
| --- | --- | --- |
| `localRoot` | yes | Synced local folder. It must contain the `.proton-sync-root` marker, created by `init`. |
| `remote` | yes | Target on the Drive: `device:<name>/<folder>` for an isolated space, `root` for My files. |
| `deviceName` | yes | Name of the machine, used in the names of conflict copies and temporary files. `init` derives it from the hostname. |
| `maxDeletes` | yes | Above this number of deleted files in one pass, the deletions are held back until `proton-sync approve`. `init` sets 20. |
| `allowDriveRoot` | only with `root` | Must be `true` to accept `remote: "root"`. Without it, any command that targets My files stops before touching the Drive. This second confirmation prevents running a test on the real Drive by mistake. Ignored for a `device:` target. |
| `verbose` | no | `true` to also write DEBUG lines: every file system event (and whether it was ignored or written by the daemon), the Drive event count of each poll, and passes with nothing to do. Default: `false`. |

Example for My files:

    {
        "localRoot": "/Users/steph/ProtonSync",
        "remote": "root",
        "deviceName": "MacBook-Air-de-alice",
        "maxDeletes": 20,
        "allowDriveRoot": true
    }

Environment variables:

- `PROTON_SYNC_HOME`: data folder (config, database, log, quarantine).
- `PROTON_SYNC_CONFIG`: path of the configuration file, if different.

Each target needs its own `PROTON_SYNC_HOME`: the database remembers which files have already been synced. With the database of another target, its files would look deleted.

## Reading the log

`proton-sync.log` (see "Where things are"), one line per event: `<UTC time> <LEVEL> <message>`.
A quiet log means everything is fine. Levels: `INFO` (what was done), `WARN` (needs attention, the daemon keeps going), `ERROR` (an action or a whole pass failed), `DEBUG` (only with `"verbose": true`).

    09:18:39 INFO  pass 411 start: local change; local changes: hulll, hoooo
    09:18:39 INFO  local→drive  move  hulll -> hoooo
    09:18:40 INFO  pass 411 done in 0.8 s: done=1 skipped=0 errors=0
    09:19:11 INFO  pass 412 start: Drive poll
    09:19:13 INFO  drive→local  move  coucou.txt -> hulll/coucou.txt
    09:25:02 ERROR local→drive  upload  Taff/big.zip: network timeout
    09:25:02 WARN  retrying in 120 s (consecutive failed passes: 3)
    09:30:00 WARN  26 deletions held (limit 20): review with 'proton-sync plan', then run 'proton-sync approve'

- `local→drive`: your change is being sent to the Drive. `drive→local`: a change made elsewhere is being applied here. `local`: a purely local step (conflict copy).
- The cause of each pass is in its `start` line: `local change` (file watcher), `Drive poll` (every 60 s), `follow-up check after work`, `retry after an error`.
- `safety stop` means the daemon refused to act (for example the local folder looks empty): no file was touched.
- An `alive:` line is written every hour.

## Where things are

- Data: `~/.local/share/proton-sync` (change with `PROTON_SYNC_HOME`). Contains `config.json`, the SQLite database and `proton-sync.log`.
- Quarantine: `~/.local/share/proton-sync/quarantine`.
- Service log on macOS: `~/Library/Logs/proton-sync.log`. On Linux: `journalctl --user -u proton-sync`.

## Recovering a file

Quarantine: every local deletion or overwrite goes there first. Browse
`~/.local/share/proton-sync/quarantine`, then copy the file you want back to its place in `~/Proton`.

Proton trash: open Proton Drive on the web, Trash section, select the item and restore it.
Proton Drive only deletes it permanently after its retention period. proton-sync never empties the trash.

## Limits

- A deletion made on purpose by the user is propagated: it remains recoverable through the trash and the quarantine.
- Sync is not an independent backup.
- The SDK is not yet guaranteed for third-party use in production.

Another limit: thumbnails are not generated for uploaded images.
Native Proton Docs and spreadsheets are never synced.
