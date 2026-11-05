#!/usr/bin/env python3
"""Tray icon for GNOME and others. Reads the daemon's desktop.json and runs proton-sync commands.

GNOME shows no tray icon without the AppIndicator extension. Fedora:
    sudo dnf install gnome-shell-extension-appindicator libayatana-appindicator-gtk3 python3-gobject
    gnome-extensions enable appindicatorsupport@rgcjonas.gmail.com
"""
import json
import os
import pathlib
import sqlite3
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


def read_activity(home, limit=200):
    """Newest first, as (time, what, file, error). Read-only; nothing yet means an empty list."""
    db = pathlib.Path(home, "state.sqlite")
    if not db.exists():
        return []
    try:
        con = sqlite3.connect(db.as_uri() + "?mode=ro", uri=True, timeout=1)
        try:
            rows = con.execute("SELECT at, label, path, COALESCE(error, '') FROM activity ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        finally:
            con.close()
    except sqlite3.Error:
        return []
    return rows


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
    window = {"open": None}

    def fill(store):
        store.clear()
        for at, label, path, error in read_activity(home):
            when = time.strftime("%d/%m %H:%M:%S", time.localtime(at / 1000))
            store.append([when, label, f"{path}  ({error})" if error else path])
        return window["open"] is not None

    def show_activity(_item):
        if window["open"]:
            window["open"].present()
            return
        win = Gtk.Window(title="proton-sync : activité récente")
        win.set_default_size(760, 460)
        store = Gtk.ListStore(str, str, str)
        view = Gtk.TreeView(model=store)
        for i, name in enumerate(["Quand", "Action", "Fichier"]):
            column = Gtk.TreeViewColumn(name, Gtk.CellRendererText(), text=i)
            column.set_resizable(True)
            view.append_column(column)
        scroll = Gtk.ScrolledWindow()
        scroll.add(view)
        win.add(scroll)
        window["open"] = win

        def closed(*_):
            window["open"] = None

        win.connect("destroy", closed)
        fill(store)
        GLib.timeout_add_seconds(3, fill, store)
        win.show_all()

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

        add("proton-sync : synchro Proton Drive")
        menu.append(Gtk.SeparatorMenuItem())
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
        add("Activité récente…", show_activity)
        add("Ouvrir le dossier", open_folder)
        add("Ouvrir le journal technique", lambda _: run("xdg-open", os.path.join(home, "proton-sync.log")))
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
