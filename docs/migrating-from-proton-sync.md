# Migrating from proton-sync

nucleon-sync is the new name of proton-sync. Your folder, your Drive and your sync history can be kept.

First stop and disable the old service, so that two daemons never run together.

    systemctl --user disable --now proton-sync.service

On macOS, use `launchctl bootout gui/$(id -u)/org.protonsync.daemon`. Then remove its file from `~/Library/LaunchAgents` so it does not start again at login.

Install nucleon-sync as described in the README, then run:

    nucleon-sync migrate

It copies the old data folder (database, configuration and session) to the new name, and adds a `.nucleon-sync-root` marker to the synced folder. The `paused` flag and the `quarantine/` folder stay in the old data folder: check the old quarantine before you delete that folder. If your old data folder is not the default one, run `nucleon-sync migrate --from <folder>`.

`migrate` refuses to run while the old service is active or enabled. It prints the commands to stop it. On macOS they are `launchctl bootout gui/$(id -u)/<label>` and `launchctl disable gui/$(id -u)/<label>`.

The environment variables `PROTON_SYNC_HOME` and `PROTON_SYNC_CONFIG` still work but are deprecated aliases. Use `NUCLEON_SYNC_HOME` and `NUCLEON_SYNC_CONFIG` instead, and change them in any script or service file of yours.

The old marker file `.proton-sync-root` and the old temporary folder `.proton-sync-tmp` are still recognised. If a crash left names like `.proton-sync-swap-*` in your synced folder, they are leftovers of the old version. Check them, then delete them by hand.

nucleon-sync cannot detect a legacy daemon that is started after it. If the old service starts again, for example at the next login, both daemons will work on the same folder. Keep the old service disabled.
