# proton-sync: design

Two-way sync daemon between `~/Proton` <-> Proton Drive, for macOS 12 Intel and Linux.
Replaces `rclone bisync`. Third-party client for personal use, identified as `external-drive-protonsync`.

## Priorities

1. Nothing is lost.
2. Renaming or moving a directory is a single operation, whatever its size.
3. Near real time, frugal with bandwidth (mobile connection).

## Principle: three-way merge

- **Base**: the last known common state (SQLite), one record per synced item.
- **Local**: disk scan. Identity = inode.
- **Remote**: mirror kept up to date by Drive events. Identity = node UID.

Each item is tracked by (parent, name), not by full path: renaming a folder changes
a single record, its descendants do not move. `reconcile(base, local, distant)` is a
pure function that returns a plan. Recovering after an interruption needs nothing special: the base
only advances after each successful action, and the next pass recomputes from the real state.

## Conflict rules (none destroys content)

| Local | Remote | Result |
|---|---|---|
| modified | modified, identical content | nothing to do |
| modified | modified, different content | both kept: local conflict copy uploaded |
| deleted | modified | the remote file comes back locally |
| modified | deleted | the local file is uploaded again |
| moved | moved elsewhere | remote wins, it is only a name |
| moved | deleted | the move wins |
| folder deleted | content added or modified inside | the folder stays with that content |
| created | created at the same place, different content | both kept |

## Structural guarantees

- `RemoteFs` exposes neither permanent deletion nor emptying the trash: the code cannot call them.
- Every local deletion or overwrite goes through quarantine first.
- Atomic local write: temporary file, verification, then rename.
- Before any local action, the item is checked again; if it has changed, the action is abandoned.
- Root missing, no marker, or an empty scan while the base is not: stop.
- Large real deletions: held for approval, the rest continues.
- First run (empty base): no deletion possible, matching by path and content.
- Proton Docs and spreadsheets, and undecryptable names: never synced or touched. A folder that
  contains any is never moved to the trash.
- Symbolic links: ignored, never followed.

## Limits

- A deletion made on purpose by the user is propagated: it remains recoverable through the trash and the quarantine.
- Sync is not an independent backup.
- The SDK is not yet guaranteed for third-party use in production.
