# nucleon-sync

Two-way sync between a folder on your computer and Proton Drive. Rename a folder and it is renamed on the Drive in one step, without uploading it again. Nothing is deleted for good.

This is a third-party tool, unofficial and not affiliated with Proton. This is a third-party application not officially supported by Proton. Proton is a trademark of Proton AG.

## Status: beta

The author tested it on a real Drive, on one Linux laptop and one Intel Mac. The installer, the setup assistant and the migration have automated tests but have not been tried in the real world yet. Supported systems: Linux x64 and macOS Intel. Apple Silicon and Windows are not supported.

Warning: a sync tool moves and deletes files. Keep a separate backup of anything you care about. Sync is not a backup.

nucleon-sync uses the Proton Drive SDK. Proton says the SDK is for personal, non-commercial use and is not ready yet for third-party apps in production. Proton plans new cryptography around the end of 2026 or early 2027, and nucleon-sync will then need an update.

## Install

    curl -fsSL https://github.com/steph-ben/nucleon-sync/releases/latest/download/install.sh | sh

GitHub's `latest` link skips prereleases. While only betas exist, use the tag link instead:

    curl -fsSL https://github.com/steph-ben/nucleon-sync/releases/download/v0.2.0-beta/install.sh | sh

The installer needs `curl`, `unzip` and `tar`. It runs as your user, writes only under `~/.local`, and downloads bun with a checksum. If `nucleon-sync` is not found afterwards, add `~/.local/bin` to your PATH.

## First run

    nucleon-sync setup

The assistant asks for the folder to sync (default `~/Proton`), signs you in, shows what the first sync would do, and only then starts the background service (systemd on Linux, launchd on macOS). Choose the test space if you want to try it first.

On Linux you need a running keyring (libsecret, for example gnome-keyring) to keep your session.

## Daily use

`nucleon-sync status` shows the state of the sync. `nucleon-sync activity` lists what really happened to your files. `nucleon-sync pause` and `nucleon-sync resume` stop and restart it. `nucleon-sync exclude add '*.tmp'` keeps matching names out of the sync (`exclude list` and `exclude remove` also exist). `nucleon-sync approve` accepts a large batch of deletions that was held back.

Other commands: `login`, `logout`, `update` (installs the latest release, and goes back to the previous one if it fails), `migrate` (see below).

## Safety

Nothing is deleted permanently. The code cannot empty the Proton trash. A file deleted or overwritten on your computer goes to the quarantine folder first, in `~/.local/share/nucleon-sync/quarantine`. A file deleted on the Drive goes to the Proton trash, which you can restore from the web.

If the synced folder looks empty or unreadable, the sync stops instead of deleting. A batch of many deletions waits for your `approve`. When both sides change the same file, both versions are kept.

## Coming from another tool

From rclone bisync, read `docs/migrating-from-rclone.md`. From the earlier name of this project, proton-sync, read `docs/migrating-from-proton-sync.md`. Do not run two sync tools on the same Drive.

## Tray icon

Tray helpers for Linux and macOS are experimental. They live in `desktop/` and are not installed by default. On Fedora GNOME they need an appindicator library: `libayatana-appindicator-gtk3` or `libappindicator-gtk3`.

## Uninstall

    nucleon-sync uninstall

This stops the service and removes the program. It keeps your data folder (`~/.local/share/nucleon-sync`) unless you add `--purge-data`. It never touches the synced folder.

## Troubleshooting

The log is `~/.local/share/nucleon-sync/nucleon-sync.log`, one line per event, and a quiet log means all is well. The service output is in `journalctl --user -u nucleon-sync` on Linux and `~/Library/Logs/nucleon-sync.log` on macOS.

## Development

    npm install
    scripts/test-all.sh

The tests need no Proton account. Design notes are in `docs/design.md`, the list of tested scenarios in `docs/test-catalog.md`.

## License

MIT, see `LICENSE`.
