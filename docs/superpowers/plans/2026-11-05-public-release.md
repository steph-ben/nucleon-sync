# Public release of nucleon-sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the tool `nucleon-sync` and make it installable by a stranger with one command, `setup`, `update` and `uninstall`, following the Proton Drive SDK terms.

**Architecture:** The program is bundled into one JavaScript file (`bun build`), shipped in a small release archive with a pinned bun. `install.sh` (a release asset stamped with the archive's SHA-256) unpacks it under `~/.local/share/nucleon-sync/app/versions/<version>` and switches a `current` link, which gives atomic installs and rollback. Everything else (setup, migration, update) is TypeScript inside the existing `src/`, with pure functions that take their inputs so tests can use a throwaway `HOME`.

**Tech Stack:** bun 1.4.2, TypeScript, POSIX `sh`, GitHub Actions, systemd user services, launchd.

**Spec:** `docs/superpowers/specs/2026-11-05-public-release-design.md`

## Global Constraints

- No `sudo`, no `npm`, no `git clone` for the end user. Everything under `~/.local`.
- Name `nucleon-sync`. HTTP header `external-drive-nucleon_sync@{major.minor.patch}-{stable|beta|alpha}`; first public release is `0.2.0-beta`.
- Sign-in screens show exactly: `This is a third-party application not officially supported by Proton.`
- No Proton logos, colours or wording; never ask for a password; sign-in stays in the browser.
- Platforms: Linux x64 (systemd user services) and macOS Intel (launchd). Anything else: a clear "not supported yet" message, exit code 1, nothing installed.
- Never delete anything during migration. Never run two daemons on one folder.
- Default local folder `~/Proton`, confirmed by the user; default target "My files" with the existing confirmation screen.
- MIT license, copyright `steph-ben`.
- Messages, docs and code in English.
- Tests only touch `device:nucleon-sync-test/...` on the Drive and temporary folders. Installer tests use a throwaway `HOME` and never the real `~/.local`.
- Do not stop, restart or edit the owner's running `proton-sync.service` or its data in `~/.local/share/proton-sync-main` at any point of this plan.
- Mobile connection: no new SDK download, small fixtures.

## Review Focus

1. The installer is interrupted or fails its checksum: nothing is left behind and the previous version still works (Task 7).
2. `~/.local/bin` is not in `PATH`: the installer prints the exact line to add and `setup` still works through the full path (Task 7).
3. The chosen folder is already synced by `rclone bisync` (the default `~/Proton` often is): setup stops and explains (Task 4).
4. No keyring on Linux (no libsecret or no running secret service): sign-in fails with the two fixes spelled out, not a stack trace (Task 4).
5. An update whose new version cannot start: the link goes back to the previous version and the daemon keeps running (Task 8).

---

### Task 1: Rename, names module, marker compatibility

**Files:**
- Create: `src/names.ts`, `test/names.test.ts`
- Modify: `src/main.ts`, `src/adapters/local.ts`, `src/core/types.ts`, `src/desktop/*.ts`, `bin/proton-sync` (move to `bin/nucleon-sync`), `deploy/*` (rename `proton-sync.service` to `nucleon-sync.service`, `org.protonsync.*` to `org.nucleonsync.*`, `proton-sync-tray.desktop` to `nucleon-sync-tray.desktop`), `desktop/linux/proton-sync-tray.py`, `desktop/macos/ProtonSyncTray.swift`, `vendor/proton-sdk/cli/src/credentials/constants.ts`, `scripts/*.sh|ts`, `.github/workflows/*.yml`, `test/*`
- Test: `test/names.test.ts`, `test/local.test.ts`

**Interfaces:**
- Produces (`src/names.ts`): `APP_NAME = 'nucleon-sync'`, `VERSION = '0.2.0'`, `CHANNEL = 'beta'`, `APP_VERSION: string` (the header), `THIRD_PARTY_NOTICE: string`, `dataDir(env: Record<string, string | undefined>, home: string): string` (`NUCLEON_SYNC_HOME` if set, else the deprecated `PROTON_SYNC_HOME` if set, else `<home>/.local/share/nucleon-sync`), `ROOT_MARKER = '.nucleon-sync-root'`, `LEGACY_ROOT_MARKER = '.proton-sync-root'`, `TMP_DIR = '.nucleon-sync-tmp'`, `LEGACY_TMP_DIR = '.proton-sync-tmp'`, `SWAP_PREFIX = '.nucleon-sync-swap-'`.
- `src/adapters/local.ts` and `src/core/types.ts` re-export these instead of defining their own.

- [ ] **Step 1: Write the failing tests**

```ts
// test/names.test.ts
test('header follows the SDK shape and says what it is', () => {
    expect(APP_VERSION).toMatch(/^external-drive-nucleon_sync@\d+\.\d+\.\d+-(stable|beta|alpha)$/);
    expect(APP_VERSION).not.toMatch(/proton/i);
});
test('no source file still uses the old name', () => { /* walk src, bin, deploy, desktop, scripts, .github, vendor/proton-sdk/cli/src/credentials;
    allowed: src/migrate.ts, docs/, test/ files that name the legacy on purpose (listed in the test) */
    expect(offenders).toEqual([]);
});
// test/local.test.ts
test('a folder that has the legacy marker is still trusted', /* assertRootSafe passes with only .proton-sync-root */);
test('both marker and tmp folder names, new and legacy, are invisible to scans', /* .nucleon-sync-tmp and .proton-sync-tmp never listed */);
```

- [ ] **Step 2: Run** `bun test test/names.test.ts test/local.test.ts` — Expected: FAIL (module and names missing).
- [ ] **Step 3: Create `src/names.ts`** with the exports above, and make `assertRootSafe` accept either marker; `createRootMarker` writes the new one; scans skip both marker and both tmp names.
- [ ] **Step 4: Rename mechanically** every other occurrence listed by the test (command in messages, data folder, header, `clientUidPrefix: 'external-drive-nucleon_sync'`, notification app name, service and plist labels, keychain service `nucleon-sync/session`, device space `device:nucleon-sync-test/...`). Keep the launcher's bun lookup order and add the bundled one in Task 6.
- [ ] **Step 5: Run** `scripts/test-all.sh` — Expected: `ALL GREEN`. Run `npx tsc --noEmit 2>&1 | grep -E '^(src|test)/'` — Expected: no output.
- [ ] **Step 6: Commit** `git commit -m "Rename the project to nucleon-sync"`

### Task 2: Keep the user-facing text English (guard only)

The Mac's commit `3b44e86` ("Show everything to the user in English") already translated the text on `main`. This task only adds the guard so it stays English, and fixes whatever the guard still finds.

**Files:**
- Modify: `test/names.test.ts`
- Modify (only if the guard finds something): the file it names

**Interfaces:** none.

- [ ] **Step 1: Write the test** in `test/names.test.ts`: `test('no French accents in user-facing source', ...)` scanning `src/`, `desktop/`, `deploy/` for `[àâçéèêëîïôùûü]`; `scripts/real-check.sh` is allowed (its accented file name is a deliberate test input).
- [ ] **Step 2: Run** `bun test test/names.test.ts` — Expected: PASS already; if it fails, translate what it names and run again.
- [ ] **Step 3: Commit** `git commit -m "Guard against French text creeping back into the interface"`

### Task 3: Third-party notice at sign-in, outdated-client problem

**Files:**
- Create: `src/desktop/signin.ts`
- Modify: `src/main.ts` (`login`, `setup`), `src/desktop/tracker.ts`, `src/desktop/state.ts`
- Test: `test/desktop.test.ts`

**Interfaces:**
- Consumes: `THIRD_PARTY_NOTICE` (Task 1).
- Produces: `signIn(auth: { authViaWeb(show: (url: string) => void): Promise<void> }, print: (line: string) => void): Promise<void>` — prints the notice, then the sign-in address. `isOutdatedClient(message: string): boolean`. Problem kind `'outdated'` added to the `Problem` union, message `'This version is no longer accepted by Proton: run nucleon-sync update'`.

- [ ] **Step 1: Write the failing tests**

```ts
test('the notice is printed before the sign-in address', async () => {
    const lines: string[] = [];
    await signIn({ authViaWeb: async (show) => show('https://x.test/y') }, (l) => lines.push(l));
    expect(lines[0]).toBe('This is a third-party application not officially supported by Proton.');
    expect(lines.some((l) => l.includes('https://x.test/y'))).toBe(true);
});
test('an outdated-client answer becomes one clear problem, not endless retries', /* tracker.passFailed(new Error(...), false) with the error text for Proton code 5003 -> problems[0].kind === 'outdated' */);
```

- [ ] **Step 2: Run** `bun test test/desktop.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement `signIn` and `isOutdatedClient`**. Proton API code `5003` appears in the vendored API types (`vendor/proton-sdk/client/js/src/internal/apiService/coreTypes.ts`); confirm in that file what it means before matching on it, and match the text the SDK really raises.
- [ ] **Step 4: Use `signIn` in `login` and `setup`; use `isOutdatedClient` in `passFailed`.**
- [ ] **Step 5: Run** `bun test test/desktop.test.ts` — Expected: PASS.
- [ ] **Step 6: Commit** `git commit -m "Show the third-party notice at sign-in and report an outdated client"`

### Task 4: Setup that is safe for a stranger

**Files:**
- Create: `src/service.ts`, `test/setup.test.ts`
- Modify: `src/desktop/setup.ts`, `src/main.ts` (`setup` case)

**Interfaces:**
- Produces (`src/desktop/setup.ts`): `otherSyncToolFor(folder: string, home: string): string | undefined` — returns a sentence naming the tool when an `rclone bisync` state file for that folder exists in `<home>/.cache/rclone/bisync/` (rclone names them after the folder path with `/` replaced by `_`), or an `rclone-bisync*` user unit/launchd label is present; otherwise `undefined`. `sessionStoreProblem(probe: () => Promise<void>): Promise<string | undefined>` — runs the probe (a write and delete of a test secret) and returns the two-fix explanation (`install libsecret and a running secret service`, or `use pass: export PROTON_DRIVE_CREDENTIALS_STORE=pass`) when it throws.
- Produces (`src/service.ts`): `renderService(os: 'linux' | 'darwin', o: { home: string; dataDir: string; command: string }): string` (systemd unit or launchd plist text), `installService(os, o, run: (cmd: string[]) => number): void` (writes the file, then `systemctl --user enable --now` / `launchctl bootstrap`).

- [ ] **Step 1: Write the failing tests**

```ts
test('rclone state for the folder is detected', /* temp HOME with .cache/rclone/bisync/home_u_Proton..proton_.path1.lst; otherSyncToolFor('<home>/Proton', home) mentions 'rclone' */);
test('an unrelated folder is not flagged', /* otherSyncToolFor('<home>/Other', home) === undefined */);
test('no keyring gives a clear message', async () => { expect(await sessionStoreProblem(async () => { throw new Error('no secret service'); })).toContain('PROTON_DRIVE_CREDENTIALS_STORE=pass'); });
test('the systemd unit points at the installed command and the data dir', /* contains `ExecStart=<command> run` and `Environment=NUCLEON_SYNC_HOME=<dataDir>` */);
test('the launchd plist is valid and labelled org.nucleonsync.daemon', /* contains the label and the command */);
test('My files still needs the explicit confirmation', /* existing buildConfig test kept */);
```

- [ ] **Step 2: Run** `bun test test/setup.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement the functions.** The data-folder variable becomes `NUCLEON_SYNC_HOME` (still read, with `PROTON_SYNC_HOME` accepted as a deprecated alias for the owner's existing setups).
- [ ] **Step 4: Rewrite the `setup` case** in `src/main.ts` as this sequence, stopping with an explanation at the first failed check: print the notice, check the session store, ask for the folder (default `~/Proton`, show it and ask to confirm), stop if `otherSyncToolFor` answers, ask the target and keep the "My files" confirmation, write the config, sign in with `signIn`, run `planOnly` and print the summary, ask "Start syncing now? [y/N]", on yes `installService` and tell where the log is.
- [ ] **Step 5: Run** `bun test test/setup.test.ts test/desktop.test.ts` — Expected: PASS.
- [ ] **Step 6: Commit** `git commit -m "Make setup safe: notice, keyring check, other-tool check, service install"`

### Task 5: Migration from proton-sync

**Files:**
- Create: `src/migrate.ts`, `test/migrate.test.ts`
- Modify: `src/main.ts` (new `migrate` command)

**Interfaces:**
- Consumes: `ROOT_MARKER`, `LEGACY_ROOT_MARKER`, `dataDir` (Task 1).
- Produces: `findLegacy(home: string): { dataDirs: string[]; services: string[] }` (data folders matching `~/.local/share/proton-sync*` that hold a `config.json`; the legacy unit `proton-sync.service` or label `org.protonsync.daemon` if present). `planMigration(legacyDir: string, newDir: string, isRunning: (dir: string) => boolean): { steps: string[]; blocked?: string }`. `applyMigration(plan, io): void` — copies `config.json` and `state.sqlite` (after a WAL checkpoint, or the three files together), copies the keychain entry `proton-sync/session` to `nucleon-sync/session` through injected `readSecret`/`writeSecret`, adds the new marker next to the legacy one in the synced folder. Never removes, moves or overwrites anything.

- [ ] **Step 1: Write the failing tests**

```ts
test('a running legacy daemon blocks the migration with a clear reason', /* planMigration(..., () => true).blocked contains 'stop the old daemon' */);
test('nothing in the legacy folder is removed or changed', /* hash tree before/after applyMigration */);
test('the new data folder gets config, database and session', /* files exist; secret copied through the fakes */);
test('an existing new data folder is never overwritten', /* applyMigration refuses and says why */);
test('the legacy marker stays and the new one is added', /* both files exist in the synced folder */);
test('the second run does nothing', /* idempotent */);
```

- [ ] **Step 2: Run** `bun test test/migrate.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `findLegacy`, `planMigration`, `applyMigration`. `isRunning` reads the legacy `daemon.lock` pid and checks it is alive.
- [ ] **Step 4: Add `nucleon-sync migrate [--from <dir>]`**: lists what it found, prints the plan, asks, applies. It tells the user to stop and disable the legacy service by hand (the exact two commands), and does not do it for them.
- [ ] **Step 5: Run** `bun test test/migrate.test.ts` and `scripts/test-all.sh` — Expected: PASS, `ALL GREEN`.
- [ ] **Step 6: Commit** `git commit -m "Add the migration from proton-sync, copy only"`

### Task 6: Bundled program and release archive

**Files:**
- Create: `scripts/build-release.sh`, `test/bundle.test.ts`
- Modify: `bin/nucleon-sync`, `.gitignore` (`dist/`)

**Interfaces:**
- Produces: `scripts/build-release.sh <version>` writes `dist/nucleon-sync-<version>.tar.gz` (contains `nucleon-sync.js`, `bin/nucleon-sync`, `deploy/`, `LICENSE`, `VERSION`), `dist/SHA256SUMS`, and `dist/install.sh` (copy of `install/install.sh` with `ARCHIVE_SHA256` and `VERSION` stamped in). The launcher runs `<app>/bun/bun run <version dir>/nucleon-sync.js "$@"` and falls back to a `bun` in `PATH` for developers.
- Archive must stay small (a few MB). The bundle is made with `bun build src/main.ts --target bun --outfile dist/nucleon-sync.js`; if bundling the vendored SDK fails, the fallback is a trimmed production `node_modules`, and the plan stops to ask.

- [ ] **Step 1: Write the failing test**

```ts
test('the bundle starts and reports its version without node_modules', /* run `bun dist/nucleon-sync.js version` from an empty temp cwd; stdout === APP_VERSION */);
test('the archive holds only what is needed', /* list entries: nucleon-sync.js, bin/nucleon-sync, deploy/*, LICENSE, VERSION; size < 15 MB */);
```

- [ ] **Step 2: Run** `bun test test/bundle.test.ts` — Expected: FAIL.
- [ ] **Step 3: Write `scripts/build-release.sh`.** Run the integration tests once against the bundle (point `test/lib/sync-child.ts` at `NUCLEON_ENTRY` when set) so the bundle is tested, not only built.
- [ ] **Step 4: Run** `bun test test/bundle.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Build a single-file bundle and the release archive"`

### Task 7: The one-command installer

**Files:**
- Create: `install/install.sh`, `test/install.test.ts`
- Remove: `scripts/install.sh`, `scripts/linux-setup.sh`

**Interfaces:**
- Produces: `install.sh` (POSIX `sh`, no root). Reads `NUCLEON_BASE_URL` (default the GitHub release download URL), `NUCLEON_BUN_URL` / `NUCLEON_BUN_SHA256` (default the pinned bun 1.4.2 zip for the detected platform and the SHA-256 from the official `SHASUMS256.txt`, embedded in the script). Layout: `~/.local/share/nucleon-sync/app/{bun/bun, versions/<v>/, current -> versions/<v>}` and `~/.local/bin/nucleon-sync -> app/current/bin/nucleon-sync`. Exit codes: 0 ok, 1 unsupported platform or failure.
- Order: detect platform, download both files to a temp dir inside `~/.local/share/nucleon-sync/.tmp`, verify both SHA-256, unpack into `versions/<v>`, switch `current`, link the command, print next steps. On any failure the temp dir is removed and `current` is untouched.

- [ ] **Step 1: Write the failing tests** (each runs `sh install/install.sh` with `HOME=<temp>`, `file://` fixtures and a stub `bun` script):

```ts
test('a fresh install creates the layout and prints the next step', /* command link exists; stdout contains 'nucleon-sync setup' */);
test('running it twice changes nothing', /* same link targets, exit 0 */);
test('a wrong checksum installs nothing', /* exit 1; no versions/, no current, no ~/.local/bin/nucleon-sync */);
test('an interrupted download leaves the previous version working', /* pre-install v1, fail v2, current still -> v1 */);
test('~/.local/bin missing from PATH prints the exact line to add', /* stdout contains 'export PATH="$HOME/.local/bin:$PATH"' */);
test('an unsupported platform is refused clearly', /* NUCLEON_UNAME_S=FreeBSD -> exit 1, 'not supported yet', nothing written */);
test('the script never calls sudo', /* source has no 'sudo' */);
```

- [ ] **Step 2: Run** `bun test test/install.test.ts` — Expected: FAIL.
- [ ] **Step 3: Write `install/install.sh`.** `shellcheck` clean if available.
- [ ] **Step 4: Run** `bun test test/install.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add the one-command installer, remove the old install scripts"`

### Task 8: `update` and `uninstall`

**Files:**
- Modify: `src/desktop/update.ts`, `src/main.ts`, `test/desktop.test.ts`
- Create: `src/uninstall.ts`, `test/update.test.ts`

**Interfaces:**
- Produces: `decideUpdate(s: { current: string; latest: string | undefined }): 'none' | 'install'`; `switchVersion(appDir: string, version: string, healthy: () => boolean): 'switched' | 'rolled-back'` (moves the `current` link, runs the health check, restores the previous link on failure); `planUninstall(home: string, keepData: boolean): string[]` (paths and services to remove; never the synced folder, and the data folder only with `--purge-data`).
- The daemon's daily check only notifies "update available: run nucleon-sync update"; it never installs by itself.

- [ ] **Step 1: Write the failing tests**

```ts
test('same or older latest means none', ...);
test('a version that fails its health check rolls the link back', /* switchVersion(..., () => false) === 'rolled-back'; current -> previous */);
test('uninstall never lists the synced folder or, by default, the data folder', ...);
test('uninstall lists the service, the command link and the program folder', ...);
```

- [ ] **Step 2: Run** `bun test test/update.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** `update` fetches `https://api.github.com/repos/steph-ben/nucleon-sync/releases/latest`, runs that release's `install.sh`, then restarts the service; the health check is `nucleon-sync version` of the new version succeeding.
- [ ] **Step 4: Run** `bun test test/update.test.ts test/desktop.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Update from releases with rollback, add uninstall"`

### Task 9: Release workflow and CI

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `.github/workflows/ci.yml`, `.github/workflows/nightly.yml`

**Interfaces:**
- Produces: on a pushed tag `v*`, jobs run the full test suite on ubuntu and on a macOS Intel runner, then build with `scripts/build-release.sh`, and publish `nucleon-sync-<version>.tar.gz`, `SHA256SUMS`, `install.sh` as release assets (prerelease flag while the version contains `-beta`).

- [ ] **Step 1: Check which Intel macOS runner label GitHub offers today** (`macos-15-intel` or its successor) and use it for the release gate. `macos-latest` is Apple Silicon and does not prove Intel support. If no Intel runner exists, keep the Mac check manual and say so in the README.
- [ ] **Step 2: Write `release.yml`**, and add `bun test test/install.test.ts test/bundle.test.ts test/update.test.ts test/migrate.test.ts test/setup.test.ts test/names.test.ts` to the CI "Main tests" step.
- [ ] **Step 3: Validate** with `actionlint` if available, otherwise by a dry run on a branch with a `v0.0.0-test` tag pushed only after the owner agrees (this is outward-facing).
- [ ] **Step 4: Commit** `git commit -m "Add the release workflow"`

### Task 10: README, LICENSE and repo hygiene

**Files:**
- Create: `LICENSE`, `docs/migrating-from-proton-sync.md`, `docs/migrating-from-rclone.md`, `test/docs.test.ts`
- Modify: `README.md`, `CLAUDE.md`
- Remove: `docs/linux-install.md`, `docs/migration.md` (their still-valid steps move into the two new files)

**Interfaces:** none.

- [ ] **Step 1: Write the failing test**

```ts
test('README says what it is, how to install, and what it is not', /* contains: the one-line install command with 'releases/latest/download/install.sh', 'unofficial', THIRD_PARTY_NOTICE, 'beta', 'Linux x64', 'macOS Intel', the SDK 'personal, non-commercial' limit, the end-of-2026 cryptography warning, 'nucleon-sync uninstall' */);
test('LICENSE is MIT with the copyright line', /* 'MIT License' and 'steph-ben' */);
test('README has no Proton logo or image', /* no <img>, no 'logo' */);
```

- [ ] **Step 2: Run** `bun test test/docs.test.ts` — Expected: FAIL.
- [ ] **Step 3: Write the files.** README in this order: what it does (two lines), install (one command), first run (`nucleon-sync setup`), daily use (status, activity, pause, exclude, approve), safety promises (nothing permanently deleted, quarantine, trash), limits and beta status, uninstall, troubleshooting (log paths), development (`npm install`, `scripts/test-all.sh`), license and non-affiliation. Short sentences, few headings, no nested lists. `CLAUDE.md`: new name, new commands, new paths; keep every absolute rule.
- [ ] **Step 4: Run** `bun test test/docs.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Write the README, add the MIT license, merge the docs"`

### Task 11: Owner actions (nothing here is automatic)

- [ ] **Step 1:** Rename the repository on GitHub (Settings, General, Repository name) to `nucleon-sync`, then `git remote set-url origin git@github.com:steph-ben/nucleon-sync.git`.
- [ ] **Step 2:** On the Mac and the Linux laptop: stop and disable the legacy service, run `nucleon-sync migrate` (it copies the config, so `setup` is not needed), start the new service with the command `migrate` prints, then check `nucleon-sync status`.
- [ ] **Step 3:** Push the tag `v0.2.0-beta` only after the owner has read the release notes. This publishes the installer publicly.

---

## Self-review

- Spec coverage: goals 1-8 map to Tasks 7, 4, 8, 1, 3, 10, 5, 10. Constraints: SDK header and notice (1, 3), crypto change (3), safety rules (global), CI (9). Non-goals respected: no Windows, no packages, no standalone binary. Tray helpers are renamed and translated (Tasks 1, 2) but **not installed by the installer in the first release**: that is my call, since the spec leaves it to the builder and they need extra system packages on Fedora.
- Names are consistent between tasks: `ROOT_MARKER`, `LEGACY_ROOT_MARKER`, `THIRD_PARTY_NOTICE`, `signIn`, `renderService`, `installService`, `switchVersion`.
- Proportion: the plan is about three times the spec's length; code is limited to test names, assertions and signatures.
