# Public release of nucleon-sync

Date: 2026-11-05. Status: draft, waiting for the owner's approval. Nothing in this document is built yet.

## Why

The tool works for its author on two machines (a Mac Intel on macOS 12, a Fedora 43 laptop) and replaces `rclone bisync`. Anyone else who finds it today has a bad time:

- It needs `bun` and `npm` installed by hand, and expects the repository in `~/dev/proton-sync`.
- There is no LICENSE file, and the README is out of date (it says "not tested on Linux").
- The name `proton-sync` reuses the Proton trademark, which the Proton Drive SDK terms forbid.
- The sign-in step does not show the notice that the SDK terms require.

Goal: a stranger who is comfortable in a terminal installs it with one command and has it working, the way they would with a mainstream app. This is a free, open-source, unofficial tool.

## Goals

1. One command installs everything, with no `sudo` and nothing to prepare (no bun, no npm, no git clone).
2. A guided `setup` takes the user from "installed" to "syncing", including start at login.
3. `update` and `uninstall` exist and are safe.
4. The project is renamed `nucleon-sync` everywhere (command, data folder, service names, HTTP header, README, repository).
5. The project follows the SDK terms and says so: unofficial, no Proton branding, the required notice at sign-in, honest identification to Proton.
6. A README a newcomer understands on first reading, in English, honest about the beta status and the limits.
7. Existing installs of `proton-sync` (the owner's two machines) migrate without losing data and without a second sync running on the same folder.
8. MIT license.

## Non-goals

- Windows, Apple Silicon, Linux arm64. Other systems get a clear "not supported yet" message. Nothing is called supported without a real test on it.
- Native packages (Homebrew, deb, rpm), a standalone compiled binary, a graphical installer.
- Commercial use or paid features. The SDK terms allow personal, non-commercial projects only.
- Replacing the official Proton Drive apps, or any look-alike of them.

## Anti-goals (a failure even if it technically works)

- Anything that makes the tool look like a Proton product: Proton logos, colours, wording, or an HTTP header that does not say what it is.
- Asking for a Proton password anywhere. Sign-in stays in the browser.
- An installer that needs `sudo`, leaves a half-installed state after an error, or cannot be undone.
- Losing or silently duplicating the owner's files while migrating from `proton-sync`.
- Two daemons (old and new) syncing the same folder.
- Breaking silently when Proton changes its cryptography (see Constraints).

## Constraints

- SDK terms (`vendor/proton-sdk/README.md`): personal and non-commercial use; no Proton branding or trademarks; the sign-in screen must say "This is a third-party application not officially supported by Proton."; the `x-pm-appversion` header must be honest and shaped `external-drive-{name}@{semver}-{channel}`, with `{name}` in lowercase letters and underscores. For this project: `external-drive-nucleon_sync`.
- Proton plans a new cryptographic model around the end of 2026 or early 2027. Clients that do not implement it will stop working. The tool must detect a failing sign-in or API error of that kind and tell the user to update, instead of retrying forever.
- No published Proton trademark policy was found. A name derived from physics ("nucleon") still evokes Proton; the residual risk is accepted by the owner.
- Safety rules from `CLAUDE.md` stay: nothing is ever permanently deleted, tests only touch `device:proton-sync-test/sandbox`, no use of the real Drive root in tests, mobile connection (small downloads, small test files).
- Building and testing the installer must never change the owner's real `~/.local`, shell files or services. Use a throwaway `HOME` for every installer test. Running it for real on the owner's machine needs a separate yes.
- Supported systems: Linux x64 with systemd (user services) and macOS Intel with launchd.
- CI today: GitHub Actions on ubuntu only, bun 1.4.2.

## Decided by the owner

- Name: `nucleon-sync`. Checked on 2026-11-05: free on npm and PyPI, no GitHub user or organisation of that name, not in PATH. Trademark databases, Homebrew, apt and Fedora were not checked.
- Audience: Linux and macOS users comfortable with a terminal.
- Installation: one command that installs everything.
- Platforms: Linux x64 and macOS Intel only.
- Default target at setup: "My files" (the Drive root).
- Default local folder: `~/Proton`, shown to the user and validated during setup.
- Installer: `curl | sh`, no `sudo`, a published release archive and a pinned bun, both checked by SHA-256, everything under `~/.local`.
- License: MIT.
- The GitHub repository is renamed to `nucleon-sync` (the owner agreed on 2026-11-05).
- No need to write to Proton before announcing the tool.

## My calls (not yet agreed, change them if you disagree)

- The install command is `curl -fsSL <release url>/install.sh | sh`. The script is a plain, readable shell file, also published as a release asset, and never runs anything as root. Program in `~/.local/share/nucleon-sync/app`, command link in `~/.local/bin`.
- `nucleon-sync setup`: shows the third-party notice, opens the browser sign-in, asks for the folder (default `~/Proton`, the user confirms or changes it), shows the "My files" confirmation screen that already exists, creates the service, enables start at login, runs a first `plan` and asks before the first `once`.
- Setup must notice another sync tool already working on the chosen folder (for example an `rclone bisync` timer or service) and stop with an explanation, because two tools writing to the same Drive and folder cause deletions and re-downloads. This matters because `~/Proton` is the folder rclone users already have.
- Copyright line of the `LICENSE`: `steph-ben` (the GitHub login), until the owner gives another name.
- `nucleon-sync update` fetches the latest release the same way; `nucleon-sync uninstall` removes the program, links and services, keeps the synced folder and the data folder unless told otherwise.
- README, docs and messages in English.
- Beta label: the first releases are called `0.x` and the README says plainly that this is beta software that moves files.
- Releases are built by GitHub Actions from a tag, on ubuntu and on a macOS Intel runner, and the full test suite must pass before a release is published.
- Migration from `proton-sync` is automatic and never deletes anything: it reads the old config and session, writes the new ones, stops and disables the old service only after asking, and leaves the old data folder in place.
- Existing helper files (`scripts/install.sh`, `scripts/linux-setup.sh`, `docs/linux-install.md`, `docs/migration.md`) are folded into the new flow or removed; one install path only.

## Left to the builder

- Exact release layout and how the archive is built.
- How `update` swaps files safely (rollback if the new version fails its first start).
- How the Linux tray and macOS menu bar helpers from `desktop/` fit in: part of `setup`, optional, or left out of the first release.
- The exact wording of messages, as long as the notice above is shown unchanged.
- Test strategy for the installer (throwaway `HOME`, a container for Linux, the owner's Mac for macOS).

## Open questions for the owner

1. Name for the `LICENSE` copyright line. Default used until answered: `steph-ben`.

The GitHub rename is done by the owner in the repository settings (the `gh` tool is not installed here); afterwards the local `origin` is repointed. The local folder `~/Code/_github/proton-sync` is not renamed: the running daemon starts through `~/.local/bin/proton-sync`, a link into that folder.
