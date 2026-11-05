# Migrating from rclone bisync

Procedure for both machines (Mac and Linux). Only move on to the next step if the previous one is correct.

Safety copy: `~/proton-safety-2026-11-05` on the Mac. The 5 native Proton documents are not in it.

1. Isolated test, without touching `~/Proton`, in a `device:proton-sync-test/sandbox` space with a temporary folder:

        mkdir -p /tmp/ps-test
        export PROTON_SYNC_HOME=/tmp/ps-home
        proton-sync login
        proton-sync init /tmp/ps-test device:proton-sync-test/sandbox
        proton-sync plan
        proton-sync once

   Create, rename and delete a few files in `/tmp/ps-test`, run `once` again, check on the web. Then `unset PROTON_SYNC_HOME`.

2. Stop rclone on BOTH machines before anything else.

   Mac:

        launchctl bootout gui/$(id -u)/org.rclone.protondrive-bisync

   Linux:

        systemctl --user disable --now rclone-bisync.timer

3. Last manual check: the two copies of `~/Proton` must be identical to each other and to the Drive. For example, on each machine:

        find ~/Proton -type f -not -path '*/.sync-config/*' | sort | wc -l

   Compare the numbers, then check any differences by eye on the web.

4. Initialize on the Mac:

        export PROTON_SYNC_HOME=~/.local/share/proton-sync-main
        ~/dev/proton-sync/bin/proton-sync init ~/ProtonSync root

   Then add `"allowDriveRoot": true` by hand in `~/.local/share/proton-sync-main/config.json`.
   Do not reuse `~/.local/share/proton-sync`: its database contains the sandbox.

5. Check the plan:

        proton-sync plan

   Expected result: only `link` actions (463 on 2026-11-05, on a clone of `~/Proton`). `coucou`, the empty file, is already on the Drive and needs no upload. No download, no move to the trash.
   If the plan contains anything else: stop, do not run `once`, work out the discrepancy.

6. First pass:

        proton-sync once

7. Start the daemon on the Mac:

        launchctl bootstrap gui/$(id -u) ~/.local/share/proton-sync-main/org.protonsync.daemon.plist

   This file is prepared separately: in `~/Library/LaunchAgents`, launchd would start it at the next login.
   Once the switch is validated, copy it to `~/Library/LaunchAgents` for automatic startup.

   Then redo steps 4 to 6 on Linux, and start the daemon:

        systemctl --user daemon-reload && systemctl --user enable --now proton-sync.service

8. Rollback: stop the daemon, then re-enable rclone.

   Mac:

        launchctl bootout gui/$(id -u)/org.protonsync.daemon
        launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.rclone.protondrive-bisync.plist

   Linux:

        systemctl --user disable --now proton-sync.service
        systemctl --user enable --now rclone-bisync.timer

   rclone bisync will have lost its reference state: it will ask for a `--resync`. This operation is delicate,
   because it redoes the matching with no memory of deletions and can recreate or duplicate files.
   Do it on one machine at a time, after checking the state of the Drive and of the safety copy.
