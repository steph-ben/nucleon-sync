# Project A: proving proton-sync is safe for critical data

Status: awaiting the user's approval. Project B (desktop experience) is separate and comes after.

## Intent

The user wants to move critical personal data onto proton-sync. Their fear is losing it. To believe
it is safe they want to see **every everyday file gesture working in the tests**, then run it for
several real days on the Mac and the Linux laptop.

This project produces that evidence, and fixes whatever it uncovers.

Today the suite is weaker than it looks. 72 tests and a 4,500-seed fuzz pass, but:

- the fuzz runs on a simulated disk only: case-sensitive, ASCII names, deletion limit disabled;
- the catalogue of gestures exists only implicitly, scattered through test names;
- faults are mostly limited to "crash before an operation";
- CI runs on Ubuntu only, while the primary machine is a case-insensitive Mac, and nobody has read its results.

A first bug already came out of a short read of the code: an unreadable file was treated as deleted
(fixed in f9d1de9). More of that kind should be expected.

## Goals

1. A readable catalogue of everyday gestures and failures, each row tied to a test that really runs.
2. Those tests pass on real file systems, on macOS and Linux, in GitHub Actions.
3. An explicit no-loss check after every scenario, not only "the two sides match".
4. Evidence that the tests can fail: deliberately breaking a safeguard must turn them red.
5. Every defect found is fixed test-first, or listed as a known limit with the user's agreement.

## Non-goals

- Anything from project B: menu bar icon, notifications, pause, custom exclusions, installer, updates.
- Performance tuning, unless a test shows data at risk.
- Sharing and native Proton documents (they stay untouched).
- A mathematical proof. "100% sure" here means: catalogue fully green, plus the real trial.

## Anti-goals (a failure even if it technically works)

- A green catalogue row whose test does not exercise what the row claims.
- Any test touching `~/Proton`, `~/ProtonSync`, "My files", or anything outside the sandbox.
- A Proton session stored on GitHub.
- Weakening a safeguard to make a test pass.

## Constraints

- All rules in `CLAUDE.md` apply: no permanent deletion, sandbox only, identification unchanged.
- Mobile connection: no heavy new dependency, small test files for anything touching the real Drive.
- Pure TDD for fixes. Commits stay small and traceable.
- Repository content stays in English.

## User's decisions

- Order: unreadable-file bug (done), then this project, then project B.
- Green light for critical data: catalogue 100% green, then a multi-day real Mac + Linux trial.
- Their real use: **photos, music and notes**. Largest files: **100 MB to 1 GB**. No git repositories.
- CI on github.com, with no Proton account or session in it.
- The real service is tested by a local command on the Mac, in `device:proton-sync-test/sandbox`.

- **"Nothing lost" means**: every version the sync saw at least once stays recoverable (local, Drive, previous
  revision, trash or quarantine). A deliberate delete goes to the trash or quarantine. In a conflict, an edit
  beats a delete. Versions replaced before the sync ever saw them are not protected. The no-loss check
  tracks deliberate deletes explicitly, and assumes nobody purges the trash during a test.
- **Defects**: any risk of losing data stops the work and goes to the user at once. Everything else
  continues, and known limits are listed for the user's agreement at the end.
- **CI results** are read with `gh`, installed on the Mac, logged in by the user.

## The catalogue

`test/catalog/` holds declarative rows: id, gesture in plain words, where it happens, expected result,
and the test. Running it generates `docs/test-catalog.md`, also shown as the CI run summary, so the
user can read what passed without reading code. A meta-test fails if a row has no running test, or
if a row is skipped.

Rows are written from the user's life. They cover at least the following.

**Everyday gestures**, each one done on the local machine, on the other machine, and on the web:
add, edit, rename, move, copy, delete, restore from the Drive trash, for an empty file, a file,
an empty folder, a nested folder.

**Names**: accents (NFC and NFD), emoji, spaces, long names up to the 255-byte limit, case-only
rename, `Photo.jpg` and `photo.jpg` together on the Drive reaching a case-insensitive Mac.

**Photos and music**:
- importing thousands of files at once, renaming or moving an album of thousands;
- reorganising a whole library, and deleting an album on purpose;
- editing tags without changing size and with the modification date preserved. A scan reuses the known
  hash when size and date match, so this edit may go unseen today: a suspected defect, to prove first;
- files of 100 MB to 1 GB: interruption and resume, without loading the file in memory.

**Notes**: rapid atomic saves of the same file, editing during upload and during download, both machines
editing the same note, an app's settings file changing constantly.

**Machine life**: sleep and wake, reboot, `kill -9`, two daemons on one configuration, full disk,
read-only file, unreadable folder, root unmounted mid-scan, root restored from a backup (every inode new),
moving items out of the root and back, inode reuse on Linux, clock changes.

**Service failures**: network cut at any step, expired session, quota full, rate limiting, Drive
asking for a full refresh, Drive reporting no hash, a download failing its hash check, corrupted or lost
local database.

**Conflict matrix**: every pair of (local gesture, remote gesture) over none, edit, rename, move, delete,
parent renamed, parent moved, parent deleted, generated exhaustively.

## Test machinery

- **Real files**: catalogue and conflict matrix run with the real local adapter and the fake Drive already
  in `test/integration.test.ts`, moved to a shared helper. The fake must also reject what Proton rejects
  (same-name collisions, invalid names) and support injected failures per operation.
- **Crash at every step**: for a catalogue scenario, the test counts its operations, then replays it
  once per operation with a crash at that exact point. This replaces hoping a random seed hits it.
- **No-loss check**: every content that ever existed must be, at the end, on the Drive (live, previous
  revision or trash), in local files, or in quarantine, unless the user destroyed it. It runs after
  every scenario. Today it runs only in the fuzz.
- **Real-file fuzz**: the fuzz runs on real folders too, with accents, case variants, nested names and
  the deletion limit active. On macOS this exercises the case-insensitive file system.
- **Safety mutants**: a script with no new dependency that breaks one safeguard at a time, such as
  removing the incomplete-scan block, the quarantine or the hash check, runs the tests, and fails if they
  stay green.

## Real service check

`proton-sync` gets a local command, or `scripts/real-check.sh`, replaying a subset of the catalogue
against the real Drive with two temporary folders. It refuses any target other than the sandbox.
Small files by default. The 100 MB to 1 GB check is opt-in, because it spends real bandwidth.

## CI

- GitHub Actions runs on `ubuntu-latest` and a macOS runner, on every push and pull request:
  all tests, the catalogue, type checking. Its summary shows the catalogue.
- A nightly run does the long fuzz and the safety mutants.
- GitHub has no macOS 12 Intel runner. The exact target machine stays covered by running the same
  suite locally before the trial.
- The repository is private, and macOS minutes cost ten times more against the free allowance. Keep
  the macOS job short and leave the long runs on Linux at night unless a macOS-only bug justifies more.
- CI results have never been read. Reading them with `gh` is part of done.

## Definition of done

- The catalogue is complete and 100% green on Linux and macOS in GitHub Actions.
- The same suite is green locally on this Mac.
- All safety mutants are caught.
- The real service check passes in the sandbox.
- `docs/migration.md` describes the Mac + Linux trial and its stop conditions.

## Builder's rules (author's calls, to be checked by the user)

**Conflict matrix.** `docs/design.md` is the authority for expected results. Where it is silent, the
default is "both contents kept", the cell is recorded as a policy gap, and the gaps are listed in the
report for the user to review. A gap never silently becomes policy.

**Known limits.** A row that cannot reasonably be fixed stays in the catalogue, marked as a known limit.
Its test asserts the limit as it really is, and the safe outcome around it. The generated catalogue
shows these apart from plain green rows. The meta-test still forbids skipped rows.

**Rows only a real trial can prove.** Real sleep and wake, and real reboots, cannot run in CI. Tests
cover their effects (a stopped daemon, a long gap, a restart). The rows are marked "confirmed by the
trial", appear in the trial checklist, and are not counted as CI-proven.

**Same-size, same-date edits.** Prove the defect first. The preferred fix is to compare ctime too,
on top of size and mtime, not to rehash everything on each scan. Adding ctime to the base is a
schema migration, and must rehash nothing on first run beyond what it needs.

**Fake Drive.** Reference, in order: real-check results, then SDK source in `node_modules`, then
behaviour already observed in the sandbox. Each rule of the fake gets a matching case in the real check,
so the fake cannot drift unnoticed. Web gestures are played in the real check by a second SDK client,
which is a stated approximation of the website. Failures that cannot be triggered safely on the real
service (quota, rate limit, expired session) are modelled from the SDK error types, and marked as such.

**Crash replay.** In-process and deterministic, at every step, for scenarios up to about 50 operations.
Bulk scenarios sample steps, always including the first, the last and every deletion. Real child
processes are used for `kill -9` and for two daemons on one configuration, on both CI systems.

**Budgets.** Bulk rows use 5,000 small files in CI. Large-file rows use a 200 MB file on a real disk
in CI, with an RSS ceiling. The 1 GB file is in the opt-in local check only.

**macOS runner.** Any current GitHub-hosted macOS runner is acceptable as a substitute for the target.
Case-insensitivity and Unicode behaviour are what matters there. The local run on the Mac is recorded
in a dated note under `docs/`, committed with the commit it ran on.

**Safety mutants.** The minimum list is every line of "Structural guarantees" in `docs/design.md`, plus
the empty-scan stop, the deletion limit, the stop-deletions-after-an-error rule and the hash check on
download. Mutants are applied to a temporary copy, never to the working tree.

## Left to the builder

File layout inside `test/`, catalogue format, helper design, how mutants are expressed, fuzz budgets
within the CI limits above, and how defects are ordered. Each defect found gets its own commit.
