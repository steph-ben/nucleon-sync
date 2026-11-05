#!/usr/bin/env python3
"""Tray icon for GNOME and others. Reads the daemon's desktop.json and runs proton-sync commands.

GNOME shows no tray icon without the AppIndicator extension. Fedora:
    sudo dnf install gnome-shell-extension-appindicator libayatana-appindicator-gtk3 python3-gobject
    gnome-extensions enable appindicatorsupport@rgcjonas.gmail.com
"""
import json
import os
import subprocess
import sys
import time

DAEMON_GONE_SECONDS = 180
ICONS = {
    "ok": "emblem-ok-symbolic",
    "syncing": "emblem-synchronizing-symbolic",
    "paused": "media-playback-pause-symbolic",
    "attention": "dialog-warning-symbolic",
    "stopped": "process-stop-symbolic",
}
STOPPED = {"level": "stopped", "title": "Synchro arrêtée", "lines": ["Le démon ne tourne pas."], "paused": False, "held": 0, "unseen": 0}


def read_state(home, now):
    """What to show. A missing, broken or old file means nobody is syncing."""
    try:
        with open(os.path.join(home, "desktop.json"), encoding="utf-8") as f:
            data = json.load(f)
        if now - data["heartbeatAt"] / 1000 >= DAEMON_GONE_SECONDS:
            return STOPPED
        view = data["view"]
        return {
            "level": view["level"],
            "title": view["title"],
            "lines": view["lines"],
            "paused": data.get("paused", False),
            "held": data.get("held", 0),
            "unseen": len(data.get("unseenDeletes", [])),
        }
    except (OSError, ValueError, KeyError, TypeError):
        return STOPPED


def main(binary, home):
    import gi

    gi.require_version("Gtk", "3.0")
    gi.require_version("AyatanaAppIndicator3", "0.1")
    from gi.repository import AyatanaAppIndicator3 as Indicator
    from gi.repository import GLib, Gtk

    env = dict(os.environ, PROTON_SYNC_HOME=home)
    indicator = Indicator.Indicator.new("proton-sync", ICONS["stopped"], Indicator.IndicatorCategory.APPLICATION_STATUS)
    indicator.set_status(Indicator.IndicatorStatus.ACTIVE)
    last = {"level": ""}

    def run(*args):
        subprocess.Popen(args, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def open_folder(_item):
        try:
            with open(os.path.join(home, "config.json"), encoding="utf-8") as f:
                run("xdg-open", json.load(f)["localRoot"])
        except (OSError, ValueError, KeyError):
            pass

    def build(state):
        menu = Gtk.Menu()

        def add(label, callback=None):
            item = Gtk.MenuItem(label=label)
            item.set_sensitive(callback is not None)
            if callback:
                item.connect("activate", callback)
            menu.append(item)

        add(state["title"])
        for line in state["lines"]:
            add(line)
        menu.append(Gtk.SeparatorMenuItem())
        if state["level"] != "stopped":
            add("Reprendre" if state["paused"] else "Mettre en pause", lambda _: run(binary, "resume" if state["paused"] else "pause"))
        if state["held"]:
            add(f"Valider {state['held']} suppressions", lambda _: run(binary, "approve"))
        if state["unseen"]:
            add("Marquer les suppressions comme vues", lambda _: run(binary, "seen"))
        add("Ouvrir le dossier", open_folder)
        add("Ouvrir le journal", lambda _: run("xdg-open", os.path.join(home, "proton-sync.log")))
        menu.append(Gtk.SeparatorMenuItem())
        add("Quitter l'icône", lambda _: Gtk.main_quit())
        menu.show_all()
        return menu

    def refresh():
        state = read_state(home, time.time())
        if state != last.get("state"):
            indicator.set_icon_full(ICONS[state["level"]], state["title"])
            indicator.set_menu(build(state))
            if state["level"] == "stopped" and last["level"] not in ("", "stopped"):
                run("notify-send", "--app-name=proton-sync", "--", "proton-sync : synchro arrêtée", "Le démon ne répond plus.")
        last.update(level=state["level"], state=state)
        return True

    refresh()
    GLib.timeout_add_seconds(3, refresh)
    Gtk.main()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: proton-sync-tray.py <path to proton-sync> <data folder>")
    main(sys.argv[1], sys.argv[2])
