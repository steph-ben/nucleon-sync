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

To switch from rclone to proton-sync, follow `docs/migration.md`.

## Continuous integration

GitHub Actions (`.github/workflows/ci.yml`, ubuntu only, bun 1.4.2) runs on every push to `main` and every pull request: the tests (`local`, `scenarios`, `integration`, `proton-adapter`), the fuzz test, then `tsc --noEmit`, which fails on any error in `src/` or `test/`.
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
| `verbose` | no | `true` for a detailed log: every watcher event, the cause of each pass (local change, Drive poll...) and its duration. Produces one line per minute even when idle. Default: `false`. |

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
