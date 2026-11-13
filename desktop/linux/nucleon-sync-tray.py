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
import warnings

warnings.filterwarnings("ignore", category=DeprecationWarning)  # Gtk.ImageMenuItem still works and is the simplest way to put an icon in a menu

SCRIPT = os.path.abspath(__file__)
DAEMON_GONE_SECONDS = 180
STOPPED_NOTIFY_AFTER_SECONDS = 60  # after a sleep the heartbeat looks old for a moment: only a daemon still silent a minute later is worth a popup
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
ICON_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
# The tray icon is our logo with a small badge for the state: icons/nucleon-sync-<state>.svg.
ICONS = {level: "nucleon-sync-" + level for level in ("ok", "syncing", "paused", "attention", "stopped")}
# Menu icons come from the desktop theme, so they follow its look.
MENU_ICONS = {
    "ok": "emblem-ok-symbolic",
    "syncing": "emblem-synchronizing-symbolic",
    "paused": "media-playback-pause-symbolic",
    "attention": "dialog-warning-symbolic",
    "stopped": "process-stop-symbolic",
}
STOPPED = {"level": "stopped", "title": "Sync stopped", "lines": ["The daemon is not running."], "paused": False, "held": 0, "unseen": 0}


def read_version(script=SCRIPT):
    """The release this tray belongs to: the VERSION file two folders up, next to bin/ and nucleon-sync.js.
    The path goes through the "current" link, so after an update it answers with the new release. None if unreadable."""
    try:
        with open(os.path.join(os.path.dirname(script), "..", "..", "VERSION"), encoding="utf-8") as f:
            return f.read().strip() or None
    except OSError:
        return None


def version_changed(started, now):
    """True when another release is installed under the same path. An unreadable file (an update in progress) changes nothing."""
    return bool(started) and bool(now) and now != started


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


def load_indicator():
    """The AppIndicator module: Ayatana if installed, else the old AppIndicator3 (Fedora ships only that one)."""
    import gi

    for name in ("AyatanaAppIndicator3", "AppIndicator3"):
        try:
            gi.require_version(name, "0.1")
        except ValueError:
            continue
        return getattr(__import__("gi.repository", fromlist=[name]), name)
    sys.exit("No AppIndicator library found. Install libayatana-appindicator-gtk3 (or libappindicator-gtk3 on Fedora).")


def main(binary, home):
    import gi

    gi.require_version("Gtk", "3.0")
    Indicator = load_indicator()
    from gi.repository import GLib, Gtk

    env = dict(os.environ, NUCLEON_SYNC_HOME=home)
    if os.path.isdir(ICON_DIR):
        indicator = Indicator.Indicator.new_with_path("nucleon-sync", ICONS["stopped"], Indicator.IndicatorCategory.APPLICATION_STATUS, ICON_DIR)
    else:
        indicator = Indicator.Indicator.new("nucleon-sync", MENU_ICONS["stopped"], Indicator.IndicatorCategory.APPLICATION_STATUS)
    indicator.set_status(Indicator.IndicatorStatus.ACTIVE)
    started = read_version()
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

    def logo_picture():
        """The logo at menu size, or nothing if the image loader cannot read SVG."""
        try:
            from gi.repository import GdkPixbuf

            return Gtk.Image.new_from_pixbuf(GdkPixbuf.Pixbuf.new_from_file_at_size(os.path.join(ICON_DIR, "nucleon-sync.svg"), 18, 18))
        except Exception:
            return Gtk.Image.new_from_icon_name("folder-remote-symbolic", Gtk.IconSize.MENU)

    def build(state):
        menu = Gtk.Menu()

        def add(label, callback=None, icon=None, picture=None):
            if icon or picture:
                item = Gtk.ImageMenuItem(label=label)
                item.set_image(picture or Gtk.Image.new_from_icon_name(icon, Gtk.IconSize.MENU))
                item.set_always_show_image(True)
            else:
                item = Gtk.MenuItem(label=label)
            item.set_sensitive(callback is not None)
            if callback:
                item.connect("activate", callback)
            menu.append(item)

        add("nucleon-sync " + started if started else "nucleon-sync", picture=logo_picture())
        menu.append(Gtk.SeparatorMenuItem())
        add(state["title"], icon=MENU_ICONS[state["level"]])
        for line in state["lines"]:
            add(line)
        menu.append(Gtk.SeparatorMenuItem())
        if state["level"] != "stopped":
            if state["paused"]:
                add("Resume", lambda _: run(binary, "resume"), "media-playback-start-symbolic")
            else:
                add("Pause", lambda _: run(binary, "pause"), "media-playback-pause-symbolic")
        if state["held"]:
            add(f"Approve {state['held']} deletions", lambda _: run(binary, "approve"), "emblem-ok-symbolic")
        if state["unseen"]:
            add("Mark deletions as seen", lambda _: run(binary, "seen"), "object-select-symbolic")
        add("Recent activity…", show_activity, "document-open-recent-symbolic")
        add("Open folder", open_folder, "folder-open-symbolic")
        add("Open technical log", lambda _: run("xdg-open", os.path.join(home, "nucleon-sync.log")), "text-x-generic-symbolic")
        menu.append(Gtk.SeparatorMenuItem())
        add("Quit icon", lambda _: Gtk.main_quit(), "application-exit-symbolic")
        menu.show_all()
        return menu

    def refresh():
        if version_changed(started, read_version()):
            # An update installed a new release: this process still runs the old code, so it starts again from the new one.
            try:
                os.execv(sys.executable, [sys.executable, SCRIPT, binary, home])
            except OSError:
                pass
        state = read_state(home, time.time())
        if state != last.get("state"):
            indicator.set_icon_full(ICONS[state["level"]] if os.path.isdir(ICON_DIR) else MENU_ICONS[state["level"]], state["title"])
            indicator.set_menu(build(state))
        if state["level"] != "stopped":
            last["stopped_since"] = None
        elif last["level"] not in ("", "stopped"):
            last["stopped_since"] = time.time()
        since = last.get("stopped_since")
        if since is not None and time.time() - since >= STOPPED_NOTIFY_AFTER_SECONDS:
            last["stopped_since"] = None
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
