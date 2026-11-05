# Installing on the Linux laptop

Stop at the first step that is not as described. Nothing here touches the Drive before step 5.

## 1. Prerequisites

    node --version    # any recent version, for npm
    curl -fsSL https://bun.sh/install | bash -s bun-v1.4.2
    exec $SHELL
    bun --version     # 1.4.2

The session is stored by `Bun.secrets`, which needs libsecret and a running keyring:

    # Debian, Ubuntu:   sudo apt install libsecret-1-0 gnome-keyring
    # Fedora:           sudo dnf install libsecret gnome-keyring

Without a desktop keyring, use `pass` instead: `export PROTON_DRIVE_CREDENTIALS_STORE=pass` for `login`, and add
`Environment=PROTON_DRIVE_CREDENTIALS_STORE=pass` to the service. Avoid `unsafe_file`: it stores the session in clear.

## 2. Code

    git clone -b reliability git@github.com:steph-ben/proton-sync.git ~/dev/proton-sync
    cd ~/dev/proton-sync
    scripts/install.sh

`install.sh` starts nothing.

## 3. Tests

    export PATH=$HOME/.local/bin:$PATH
    scripts/test-all.sh

Temporary folders only, no account needed. Expected last line: `ALL GREEN`. If not, do not go further.

## 4. Login

    proton-sync login

Open the address it prints. Never paste a password anywhere else.

## 5. Isolated trial, in a throwaway space

    export PROTON_SYNC_HOME=~/.local/share/proton-sync-test
    mkdir -p ~/proton-sync-test
    proton-sync init ~/proton-sync-test device:proton-sync-test/sandbox-linux
    proton-sync plan
    proton-sync once

Create, rename and delete a few files in `~/proton-sync-test`, run `once` again, and check on the web.
Then `unset PROTON_SYNC_HOME`.

## 6. My files

Only once the Mac daemons run the same code as the laptop. Follow `docs/migration.md`, steps 2 to 7, Linux side:
stop rclone first, and read `plan` before the first `once`. Anything other than `link` actions needs an explanation.

## Troubleshooting

- `proton-sync status`: last pass.
- `~/.local/share/proton-sync/proton-sync.log`: the journal.
- `journalctl --user -u proton-sync`: what the service printed.
- Stop everything: `systemctl --user disable --now proton-sync.service`.
