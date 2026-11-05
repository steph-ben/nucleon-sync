#!/usr/bin/env python3
"""Tray icon for GNOME and others. Reads the daemon's desktop.json and runs nucleon-sync commands.

GNOME shows no tray icon without the AppIndicator extension. Fedora:
    sudo dnf install gnome-shell-extension-appindicator libayatana-appindicator-gtk3 python3-gobject
    gnome-extensions enable appindicatorsupport@rgcjonas.gmail.com
"""
import calendar
import json
import os
import re
import subprocess
import sys
import time

DAEMON_GONE_SECONDS = 180
TAIL_BYTES = 256 * 1024
LINE = re.compile(r"^(\S+) (INFO |ERROR) (local→drive|drive→local|local)  (.+?)  (.+)$")
LABELS = {
    "upload": "Uploaded",
    "upload new version": "Uploaded (new version)",
    "download": "Downloaded",
    "download new version": "Downloaded (new version)",
    "trash": "Moved to trash",
    "quarantine": "Moved to quarantine",
    "conflict copy": "Conflict: copy created",
}
ICONS = {
    "ok": "emblem-ok-symbolic",
    "syncing": "emblem-synchronizing-symbolic",
    "paused": "media-playback-pause-symbolic",
    "attention": "dialog-warning-symbolic",
    "stopped": "process-stop-symbolic",
}
STOPPED = {"level": "stopped", "title": "Sync stopped", "lines": ["The daemon is not running."], "paused": False, "held": 0, "unseen": 0}


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


def iso_seconds(at):
    return calendar.timegm(time.strptime(at[:19], "%Y-%m-%dT%H:%M:%S"))


def describe(op, to_drive):
    if op == "move":
        return "Moved on Drive" if to_drive else "Moved here"
    if op == "mkdir":
        return "Folder created on Drive" if to_drive else "Folder created here"
    return LABELS.get(op, op)


def read_activity(home, limit=200):
    """Newest first, as [time, what, file, error], from the end of the daemon's journal."""
    try:
        with open(os.path.join(home, "nucleon-sync.log"), "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - TAIL_BYTES))
            text = f.read().decode("utf-8", "replace")
    except OSError:
        return []
    rows = []
    for line in reversed(text.split("\n")):
        found = LINE.match(line)
        if not found:
            continue
        at, level, direction, op, rest = found.groups()
        label = describe(op, direction == "local→drive")
        error = ""
        if level == "ERROR":
            rest, _, error = rest.partition(": ")
            label = "Error: " + label
        rows.append([at, label, rest, error])
        if len(rows) == limit:
            break
    return rows


def main(binary, home):
    import gi

    gi.require_version("Gtk", "3.0")
    gi.require_version("AyatanaAppIndicator3", "0.1")
    from gi.repository import AyatanaAppIndicator3 as Indicator
    from gi.repository import GLib, Gtk

    env = dict(os.environ, NUCLEON_SYNC_HOME=home)
    indicator = Indicator.Indicator.new("nucleon-sync", ICONS["stopped"], Indicator.IndicatorCategory.APPLICATION_STATUS)
    indicator.set_status(Indicator.IndicatorStatus.ACTIVE)
    last = {"level": ""}
    window = {"open": None}

    def fill(store):
        store.clear()
        for at, label, path, error in read_activity(home):
            when = time.strftime("%d/%m %H:%M:%S", time.localtime(iso_seconds(at)))
            store.append([when, label, f"{path}  ({error})" if error else path])
        return window["open"] is not None

    def show_activity(_item):
        if window["open"]:
            window["open"].present()
            return
        win = Gtk.Window(title="nucleon-sync: recent activity")
        win.set_default_size(760, 460)
        store = Gtk.ListStore(str, str, str)
        view = Gtk.TreeView(model=store)
        for i, name in enumerate(["When", "Action", "File"]):
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

        add("nucleon-sync: Proton Drive sync")
        menu.append(Gtk.SeparatorMenuItem())
        add(state["title"])
        for line in state["lines"]:
            add(line)
        menu.append(Gtk.SeparatorMenuItem())
        if state["level"] != "stopped":
            add("Resume" if state["paused"] else "Pause", lambda _: run(binary, "resume" if state["paused"] else "pause"))
        if state["held"]:
            add(f"Approve {state['held']} deletions", lambda _: run(binary, "approve"))
        if state["unseen"]:
            add("Mark deletions as seen", lambda _: run(binary, "seen"))
        add("Recent activity…", show_activity)
        add("Open folder", open_folder)
        add("Open technical log", lambda _: run("xdg-open", os.path.join(home, "nucleon-sync.log")))
        menu.append(Gtk.SeparatorMenuItem())
        add("Quit icon", lambda _: Gtk.main_quit())
        menu.show_all()
        return menu

    def refresh():
        state = read_state(home, time.time())
        if state != last.get("state"):
            indicator.set_icon_full(ICONS[state["level"]], state["title"])
            indicator.set_menu(build(state))
            if state["level"] == "stopped" and last["level"] not in ("", "stopped"):
                run("notify-send", "--app-name=nucleon-sync", "--", "nucleon-sync: sync stopped", "The daemon stopped responding.")
        last.update(level=state["level"], state=state)
        return True

    refresh()
    GLib.timeout_add_seconds(3, refresh)
    Gtk.main()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: nucleon-sync-tray.py <path to nucleon-sync> <data folder>")
    main(sys.argv[1], sys.argv[2])
