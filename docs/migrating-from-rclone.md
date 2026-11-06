# Migrating from rclone bisync

Two sync tools on the same Drive cause deletions and re-downloads, because each one sees the other's changes as user edits. Use only one at a time. Go step by step, and only continue when the previous step looks right.

Keep a copy of your folder somewhere else before you start. Native Proton documents are never synced, so they will not be in that copy.

1. Stop rclone on all your machines before anything else. For a systemd timer: `systemctl --user disable --now rclone-bisync.timer`. For launchd on macOS: `launchctl bootout gui/$(id -u)/org.rclone.protondrive-bisync`, then `launchctl disable gui/$(id -u)/org.rclone.protondrive-bisync`. Setup refuses to go on while an rclone unit is running or enabled. If rclone only left its files in `.cache/rclone/bisync`, setup names the file, warns you, and goes on after you type `yes`. It cannot see rclone started from cron or a script, so typing `yes` means you checked.

2. Check that the folders of all machines are identical to each other and to the Drive. Counting files on each machine and comparing the numbers is a good first test.

3. Try first in the test space. Run `nucleon-sync setup` and choose the test space (2). Create, rename and delete a few files, and look at the result on the web.

4. On the first machine, run `nucleon-sync setup` and choose My files. Setup shows the plan before it starts anything. If you prefer to look at it again, run `nucleon-sync plan`.

5. The first `plan` should show only `link` actions: each local file is matched with the identical file already on the Drive. Any download, upload or move to the trash means the two sides differ. Stop, do not sync, and find out why.

6. Once the first machine is syncing well, repeat on the next one.

To go back to rclone, stop nucleon-sync first with `nucleon-sync pause` or by disabling its service. rclone bisync will have lost its reference state and will ask for `--resync`. Be careful with `--resync`: it matches both sides again with no memory of deletions, so it can recreate or duplicate files. Do it on one machine at a time, after checking the Drive and your backup.
