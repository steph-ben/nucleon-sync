# Migrating from proton-sync

nucleon-sync is the new name of proton-sync. Your folder, your Drive and your sync history can be kept.

First stop and disable the old service, so that two daemons never run together.

    systemctl --user disable --now proton-sync.service

On macOS, use `launchctl bootout gui/$(id -u)/org.protonsync.daemon`. Then remove its file from `~/Library/LaunchAgents` so it does not start again at login.

Install nucleon-sync as described in the README, then run:

    nucleon-sync migrate

It copies the old data folder (database, configuration and session) to the new name. It only copies: the old folder is left as it was, so you can check everything and delete it yourself later.

The environment variables `PROTON_SYNC_HOME` and `PROTON_SYNC_CONFIG` still work but are deprecated aliases. Use `NUCLEON_SYNC_HOME` and `NUCLEON_SYNC_CONFIG` instead, and change them in any script or service file of yours.

The old marker file `.proton-sync-root` and the old temporary folder `.proton-sync-tmp` are still recognised. If a crash left names like `.proton-sync-swap-*` in your synced folder, they are leftovers of the old version. Check them, then delete them by hand.

nucleon-sync cannot detect a legacy daemon that is started after it. If the old service starts again, for example at the next login, both daemons will work on the same folder. Keep the old service disabled.
