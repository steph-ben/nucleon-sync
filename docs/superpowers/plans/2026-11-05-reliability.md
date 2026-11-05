# Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Prove every everyday gesture and failure with tests that really run, on macOS and Linux, and fix what they uncover.

**Architecture:** One shared test world (real folders, fake Drive with fault injection, no-loss ledger). A catalogue of declarative rows, each executed by `bun test`, generates `docs/test-catalog.md`. Mutants run on a temporary copy.

**Tech Stack:** bun 1.4.2, TypeScript, `bun:test`, GitHub Actions. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-05-reliability-design.md`

## Global Constraints

- No Proton access in CI, no session on GitHub.
- Tests only use temporary folders, and the real check only `device:proton-sync-test/sandbox`.
- Any data-loss risk without a simple fix: stop and tell the user.
- A safeguard is never weakened to pass a test.
- Repository content in English. Each defect gets its own commit, test first.

## Review Focus

1. Accented names in NFD on the Mac, NFC on the Drive: no duplicate, no delete-and-recreate.
2. Base database lost or corrupted: next pass deletes nothing.
3. Same-size edit with preserved date (music tags): reaches the Drive.
4. Local root unmounted or emptied during a pass: no deletion reaches the Drive.
5. Download failing its hash check: the old local version stays intact.

---

### Task 1: Test world and catalogue

**Files:** Create `test/lib/world.ts`, `test/lib/catalog.ts`, `test/catalog/meta.test.ts`, `scripts/catalog-report.ts`. Modify `test/integration.test.ts`.

**Interfaces:**
- Produces: `world({ devices?, caseInsensitive? }) -> { hub, a, b, drive, ledger, settle(), web }`; `row({ id, area, gesture, expected, status? }, fn)`; `FakeDrive` fault hook `fail(op, error, times?)`; `ledger.saw(content)`, `ledger.destroyed(content)`, `ledger.assertNothingLost()`.

- [ ] Move `FileRemote`, `machine`, `settle`, `tree`, `allFiles` into `test/lib/world.ts`; integration tests stay green.
- [ ] `row()` registers a `bun:test` test and appends its result to `CATALOG_OUT` when set. `status` is `proved` (default), `limit` or `trial`.
- [ ] Meta-test: no duplicate id, no skipped row, all areas present.
- [ ] `scripts/catalog-report.ts` writes `docs/test-catalog.md`. Commit.

### Task 2: Everyday gestures

**Files:** Create `test/catalog/gestures.test.ts`.

- [ ] Generate rows for gesture × origin × object: add, edit, rename, move, copy, delete, restore; local, other machine, web; empty file, file, empty folder, nested folder. Each ends with `settle()`, identical trees and `assertNothingLost()`.
- [ ] Run, fix defects test-first, commit.

### Task 3: Names

**Files:** Create `test/catalog/names.test.ts`.

- [ ] Rows: NFC, NFD, emoji, spaces, 255-byte name, too-long name from the Drive, case-only rename, `Photo.jpg` + `photo.jpg` on a case-insensitive disk (`limit` row if one stays Drive-only, with a visible warning asserted).
- [ ] Run, fix, commit.

### Task 4: Photos and music, notes

**Files:** Create `test/catalog/media.test.ts`, `test/catalog/notes.test.ts`. Possibly modify `src/adapters/local.ts`, `src/core/types.ts`, `src/adapters/sqlite-store.ts`.

- [ ] Rows: import 5,000 files, rename and move an album, reorganise a library, delete an album (limit then approve), same-size edit with preserved mtime, 200 MB transfer with interruption and an RSS ceiling.
- [ ] Rows: rapid atomic saves, edit during upload, edit during download, both machines editing a note, constantly changing settings file.
- [ ] If the same-size edit is unseen: add `localCtime` to `BaseRec`, migrate SQLite, compare it in the hash reuse.
- [ ] Run, fix, commit.

### Task 5: Machine life and service failures

**Files:** Create `test/catalog/machine.test.ts`, `test/catalog/service.test.ts`, `test/lib/daemon.ts`.

- [ ] Machine rows: full disk, read-only file, unreadable folder, root unmounted mid-scan, restore from backup (new inodes), out of root and back, inode reuse, clock change, base deleted, base corrupted; real child process `kill -9` and two daemons on one configuration; sleep and reboot as `trial` rows.
- [ ] Service rows: network cut per operation, expired session, quota, rate limit, full refresh, missing hash, bad-hash download, corrupted mirror.
- [ ] Run, fix, commit.

### Task 6: Conflict matrix

**Files:** Create `test/catalog/conflicts.test.ts`.

- [ ] Generate 8 × 8 pairs over none, edit, rename, move, delete, parent renamed, parent moved, parent deleted. Assert convergence and no loss. Record expected outcome against `docs/design.md`; policy gaps listed in `docs/test-catalog.md`.
- [ ] Run, fix, commit.

### Task 7: Crash at every step, and real-file fuzz

**Files:** Create `test/catalog/crash.test.ts`, `test/fuzz-real.test.ts`.

- [ ] Replay scenarios once per operation with a crash at that point; full under 50 operations, sampled above (first, last, every deletion).
- [ ] Real-file fuzz with accents, case variants, deletion limit on, reusing the ledger. Budget set by `FUZZ_N`.
- [ ] Run, fix, commit.

### Task 8: Safety mutants

**Files:** Create `scripts/mutants.ts`.

- [ ] One mutant per guarantee in the spec's list, applied on a temporary copy; fails if the tests stay green or if a patch no longer applies.
- [ ] Add a test for every survivor. Commit.

### Task 9: CI

**Files:** Modify `.github/workflows/ci.yml`. Create `.github/workflows/nightly.yml`.

- [ ] Matrix ubuntu + macOS, all tests, catalogue in the run summary. Nightly: long fuzz and mutants on Linux.
- [ ] Push, read the runs with `gh`, fix until green.

### Task 10: Real check and trial

**Files:** Create `scripts/real-check.ts`. Modify `docs/migration.md`, `README.md`, `CLAUDE.md`.

- [ ] Real check refusing any target but the sandbox, with a second SDK client as the web; 1 GB behind `--large`.
- [ ] Run it (small files), record a dated note under `docs/`.
- [ ] Write the Mac + Linux trial with its stop conditions.
