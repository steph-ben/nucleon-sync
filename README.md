<p align="center">
  <img src="assets/banner.svg" alt="nucleon-sync: two-way sync for Proton Drive" width="760">
</p>

<p align="center">
  <a href="https://github.com/steph-ben/nucleon-sync/releases"><img alt="Release" src="https://img.shields.io/github/v/release/steph-ben/nucleon-sync?include_prereleases&label=release"></a>
  <a href="https://github.com/steph-ben/nucleon-sync/actions/workflows/ci.yml"><img alt="Tests" src="https://img.shields.io/github/actions/workflow/status/steph-ben/nucleon-sync/ci.yml?branch=main&label=tests"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Linux x64 and macOS Intel" src="https://img.shields.io/badge/platform-Linux%20x64%20%7C%20macOS%20Intel-lightgrey">
</p>

**nucleon-sync keeps a folder on your computer and your Proton Drive identical, in both directions, in the background.** Rename a folder of 5,000 photos: it is one rename on the Drive, not 5,000 uploads. Delete something by mistake: it can still be recovered.

```sh
curl -fsSL https://steph-ben.github.io/nucleon-sync/install.sh | sh
```

One command, no `sudo`, nothing to prepare. It installs under `~/.local`, then starts a short setup: choose a folder, sign in on Proton's own page, see what the first sync would do, and say yes. Full details are in `install/install.sh`, a short script you can read first.

> [!IMPORTANT]
> **Beta, unofficial, not affiliated with Proton.** This is a third-party application not officially supported by Proton. Proton is a trademark of Proton AG. Sync is not a backup: keep a separate copy of what you care about.

## How it works

```text
 YOUR COMPUTER                                                     PROTON
┌───────────────────────────────────────────────────────┐
│  ~/Proton              your files, plain files        │
│      ▲                                                │
│      │ watches, reads, writes                         │
│      ▼                                                │
│  nucleon-sync          background service             │
│      │  ├─ state.sqlite   what was last in sync       │
│      │  └─ quarantine/    what sync replaced here     │
│      ▼                                                │
│  Proton Drive SDK      Proton's own open-source code  │      ┌────────────┐
│      │                 encrypts before anything       │ ───▶ │ Your Drive │
│      │                 leaves your computer           │ ◀─── │ encrypted  │
│      └─ session in your system keyring                │ TLS  └────────────┘
└───────────────────────────────────────────────────────┘
```

**Proton's SDK does the sensitive work.** Every Drive operation goes through the [Proton Drive SDK](https://github.com/ProtonDriveApps/sdk): listing, upload, download, move, rename, trash, and the encryption of all of it. nucleon-sync has no crypto of its own and makes no direct calls to Proton's servers. It is not the official client, but it uses the same library, and it identifies itself honestly to Proton as `external-drive-nucleon_sync`.

**Your password never reaches nucleon-sync.** You sign in on Proton's web page, and the resulting session is kept in your system keyring.

**Nothing is sent anywhere else.** No analytics, no crash reports, no server of ours. The only network traffic goes to Proton.

**The database holds no file content.** `state.sqlite` remembers, for each file and folder: its name, its parent, its local and Drive identifiers, a SHA-1 hash, its size and date. That is how a rename is told from a delete plus a new file. It sits in `~/.local/share/nucleon-sync`, unencrypted, readable like your files themselves. Lose it and the next run matches files again by content, without deleting anything.

## What gets installed

| What | Where |
| --- | --- |
| The command | `~/.local/bin/nucleon-sync` |
| The program, with its own bun runtime (about 80 MB) | `~/.local/share/nucleon-sync/app` |
| Configuration, database, log, quarantine | `~/.local/share/nucleon-sync` |
| The background service | systemd on Linux, launchd on macOS, in your user account |
| The tray icon, on Linux | `~/.config/autostart`, if your desktop has the library it needs |
| Your Proton session | your system keyring |

`nucleon-sync uninstall` removes all of this. It never touches the synced folder.

## How your files are protected

Nothing is deleted permanently. The code cannot empty the Proton trash, and a test checks it has no way to.

A file you delete on your computer goes to the Proton trash, which you can restore from the web. A file deleted or replaced on the Drive is kept in `~/.local/share/nucleon-sync/quarantine` before it is removed or overwritten on your computer.

| If this happens | nucleon-sync does this |
| --- | --- |
| You and another machine edit the same file | Both versions are kept |
| The folder looks empty (disk not mounted, for example) | It stops, and nothing is deleted |
| More than 20 deletions at once | It waits for `nucleon-sync approve` |
| A file cannot be read | It is left alone, on both sides |
| The configuration points at another Drive target | It stops before planning anything |
| The computer crashes in the middle of a sync | It resumes without losing or redoing anything |

Each of these has automated tests: about 220 everyday and failure scenarios ([the list](docs/test-catalog.md)), a crash test at every single step, and random simulations of two machines. `DriveApi` in `src/adapters/proton.ts` exposes no permanent deletion.

## Daily use

The sync runs by itself. These are there when you want them:

    nucleon-sync status                  where things stand
    nucleon-sync activity                what really happened to your files
    nucleon-sync pause / resume          stop and restart
    nucleon-sync exclude add '*.tmp'     keep matching names out (exclude list, exclude remove)
    nucleon-sync approve                 accept a large batch of deletions that was held back
    nucleon-sync update                  install the latest release, and go back if it fails
    nucleon-sync uninstall               remove the program

`nucleon-sync uninstall` keeps your data folder (`~/.local/share/nucleon-sync`) unless you add `--purge-data`, which also deletes the quarantine and your saved sign-in.

To change the folder or the target, stop the service and run `nucleon-sync setup --reset`: it moves the configuration and the database aside, deletes nothing, then runs the setup again. To try it on a throwaway space first, run `nucleon-sync setup --test-space` with a small folder.

## Status and limits

This is beta software. The author uses it daily on a real Drive. The whole install chain has been tried on Linux; on macOS, parts of it are covered by tests only. Supported systems: Linux x64 and macOS Intel. Apple Silicon and Windows are not supported yet.

The Proton Drive SDK is meant for personal, non-commercial use for now, and Proton says it is not ready yet for third-party apps in production. Proton plans new cryptography around the end of 2026 or early 2027, and nucleon-sync will need an update by then. It tells you when that happens.

On Linux you need a running keyring (libsecret, for example gnome-keyring). The tray icon needs `libayatana-appindicator-gtk3` or `libappindicator-gtk3`, and on GNOME the AppIndicator extension. Native Proton Docs and Sheets are never synced.

Coming from rclone? Stop it first on all your machines, and read `docs/migrating-from-rclone.md`. Never run two sync tools on the same Drive. Coming from this project's earlier name, proton-sync? Read `docs/migrating-from-proton-sync.md`.

## Troubleshooting

The log is `~/.local/share/nucleon-sync/nucleon-sync.log`, one line per event, and no warnings or errors in the log means all is well. The service output is in `journalctl --user -u nucleon-sync` on Linux and `~/Library/Logs/nucleon-sync.log` on macOS.

## Development

    npm install --ignore-scripts
    bash scripts/patch-crypto.sh
    scripts/test-all.sh

The tests need no Proton account. Design notes are in `docs/design.md`.

## License

MIT, see `LICENSE`. Bundled libraries are listed in `THIRD-PARTY-NOTICES` in each release.
