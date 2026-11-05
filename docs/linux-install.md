# Installing on the Linux laptop

Stop at the first step that is not as described. Nothing here touches the Drive before step 3.

## 1. Install and test

    git clone -b reliability git@github.com:steph-ben/proton-sync.git ~/dev/proton-sync
    ~/dev/proton-sync/scripts/linux-setup.sh

It installs bun 1.4.2, the dependencies, the `proton-sync` command and the service file, then runs every test in
temporary folders. It starts nothing. Expected end: `ALL GREEN`. If not, do not go further.

Needs `npm`, `curl`, `unzip`, and libsecret with a running keyring for the session
(Debian, Ubuntu: `sudo apt install npm curl unzip libsecret-1-0 gnome-keyring`).
Without a desktop keyring, use `pass`: `export PROTON_DRIVE_CREDENTIALS_STORE=pass` for `login`, and add
`Environment=PROTON_DRIVE_CREDENTIALS_STORE=pass` to the service. Avoid `unsafe_file`: it stores the session in clear.

## 2. Login

    proton-sync login

Open the address it prints. Never paste a password anywhere else.

## 3. Isolated trial, in a throwaway space

    export PROTON_SYNC_HOME=~/.local/share/proton-sync-test
    mkdir -p ~/proton-sync-test
    proton-sync init ~/proton-sync-test device:proton-sync-test/sandbox-linux
    proton-sync plan
    proton-sync once

Create, rename and delete a few files in `~/proton-sync-test`, run `once` again, and check on the web.
Then `unset PROTON_SYNC_HOME`.

## 4. My files

Only once the Mac daemons run the same code as the laptop. Follow `docs/migration.md`, steps 2 to 7, Linux side:
stop rclone first, and read `plan` before the first `once`. Anything other than `link` actions needs an explanation.

## Troubleshooting

- `proton-sync status`: last pass.
- `~/.local/share/proton-sync/proton-sync.log`: the journal.
- `journalctl --user -u proton-sync`: what the service printed.
- Stop everything: `systemctl --user disable --now proton-sync.service`.
