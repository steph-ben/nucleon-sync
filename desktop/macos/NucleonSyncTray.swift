// Menu bar icon. Reads the daemon's desktop.json and runs nucleon-sync commands: all logic stays in the daemon.
// Usage: nucleon-sync-tray <path to nucleon-sync> <data folder> [<installed program folder: .../app/current>]
// It must stay the same as desktop/linux/nucleon-sync-tray.py (same menu, same words, same icons): test/tray-parity.test.ts checks it.
import AppKit

let daemonGoneSeconds = 180.0

struct State {
    var level = "stopped"
    var title = "Sync stopped"
    var lines: [String] = ["The daemon is not running."]
    var paused = false
    var held = 0
    var unseen = 0
}

struct Activity {
    let when: String
    let what: String
    let file: String
}

let tailBytes = 256 * 1024
// The icon in the menu bar is our logo (two rings) with a small badge for the state, drawn here as a template image:
// one colour, so macOS paints it like the other icons of the bar, in light and in dark mode, on a transparent background.
func statusIcon(_ level: String) -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
        guard let g = NSGraphicsContext.current?.cgContext else { return false }
        g.setFillColor(NSColor.black.cgColor)
        g.setStrokeColor(NSColor.black.cgColor)
        g.setLineCap(.round)
        g.setLineJoin(.round)
        g.setLineWidth(1.5)
        for x in [6.0, 11.4] { g.strokeEllipse(in: CGRect(x: x - 4.4, y: 10.2 - 4.4, width: 8.8, height: 8.8)) }
        let c = CGPoint(x: 13.2, y: 4.6)
        g.setBlendMode(.destinationOut)
        g.fillEllipse(in: CGRect(x: c.x - 5.6, y: c.y - 5.6, width: 11.2, height: 11.2))
        g.setBlendMode(.normal)
        g.fillEllipse(in: CGRect(x: c.x - 4.4, y: c.y - 4.4, width: 8.8, height: 8.8))
        g.setBlendMode(.destinationOut)
        g.setLineWidth(1.3)
        func at(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: c.x + x, y: c.y + y) }
        switch level {
        case "ok":
            g.addLines(between: [at(-1.8, 0.1), at(-0.5, -1.3), at(1.9, 1.4)])
            g.strokePath()
        case "syncing":
            g.addArc(center: c, radius: 1.9, startAngle: 0.7, endAngle: 0.7 + 5.2, clockwise: false)
            g.strokePath()
        case "paused":
            g.fill(CGRect(x: c.x - 1.7, y: c.y - 1.8, width: 1.2, height: 3.6))
            g.fill(CGRect(x: c.x + 0.5, y: c.y - 1.8, width: 1.2, height: 3.6))
        case "attention":
            g.fill(CGRect(x: c.x - 0.6, y: c.y - 0.6, width: 1.2, height: 2.6))
            g.fillEllipse(in: CGRect(x: c.x - 0.7, y: c.y - 2.1, width: 1.4, height: 1.4))
        default: // stopped
            g.addLines(between: [at(-1.6, -1.6), at(1.6, 1.6)])
            g.addLines(between: [at(-1.6, 1.6), at(1.6, -1.6)])
            g.strokePath()
        }
        return true
    }
    image.isTemplate = true
    return image
}
// Icons of the menu rows, the counterpart of MENU_ICONS in the Linux tray.
let menuSymbols = ["ok": "checkmark.circle", "syncing": "arrow.triangle.2.circlepath", "paused": "pause.circle",
                   "attention": "exclamationmark.triangle", "stopped": "stop.circle"]
let labels = ["upload": "Uploaded", "upload new version": "Uploaded (new version)", "download": "Downloaded",
              "download new version": "Downloaded (new version)", "trash": "Moved to trash",
              "quarantine": "Moved to quarantine", "conflict copy": "Conflict: copy created"]

func describe(_ op: String, toDrive: Bool) -> String {
    if op == "move" { return toDrive ? "Moved on Drive" : "Moved here" }
    if op == "mkdir" { return toDrive ? "Folder created on Drive" : "Folder created here" }
    return labels[op] ?? op
}

/// Newest first, from the end of the daemon's journal.
func readActivity(home: String, limit: Int = 200) -> [Activity] {
    let url = URL(fileURLWithPath: home).appendingPathComponent("nucleon-sync.log")
    guard let file = try? FileHandle(forReadingFrom: url) else { return [] }
    defer { try? file.close() }
    guard let size = try? file.seekToEnd() else { return [] }
    try? file.seek(toOffset: size > UInt64(tailBytes) ? size - UInt64(tailBytes) : 0)
    guard let data = try? file.readToEnd() else { return [] }
    let parse = ISO8601DateFormatter()
    parse.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let show = DateFormatter()
    show.dateFormat = "dd/MM HH:mm:ss"
    var rows: [Activity] = []
    for line in String(decoding: data, as: UTF8.self).split(separator: "\n").reversed() {
        guard line.count > 31 else { continue }
        let body = line.dropFirst(25)
        let isError = body.hasPrefix("ERROR ")
        guard isError || body.hasPrefix("INFO  ") else { continue }
        let parts = body.dropFirst(6).components(separatedBy: "  ")
        guard parts.count >= 3, ["local→drive", "drive→local", "local"].contains(parts[0]) else { continue }
        var file = parts[2...].joined(separator: "  ")
        var what = describe(parts[1], toDrive: parts[0] == "local→drive")
        if isError {
            what = "Error: " + what
            if let colon = file.range(of: ": ") { file = "\(file[..<colon.lowerBound])  (\(file[colon.upperBound...]))" }
        }
        let at = parse.date(from: String(line.prefix(24))).map(show.string(from:)) ?? ""
        rows.append(Activity(when: at, what: what, file: file))
        if rows.count == limit { break }
    }
    return rows
}

final class ActivityWindow: NSObject, NSTableViewDataSource, NSTableViewDelegate, NSWindowDelegate {
    let home: String
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 460), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
    let table = NSTableView()
    var rows: [Activity] = []
    var timer: Timer?

    init(home: String) {
        self.home = home
        super.init()
        window.title = "nucleon-sync: recent activity"
        window.isReleasedWhenClosed = false
        window.delegate = self
        for (id, title, width) in [("when", "When", 120.0), ("what", "Action", 200.0), ("file", "File", 420.0)] {
            let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(id))
            column.title = title
            column.width = CGFloat(width)
            table.addTableColumn(column)
        }
        table.dataSource = self
        table.delegate = self
        table.usesAlternatingRowBackgroundColors = true
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        window.contentView = scroll
        window.center()
    }

    func show() {
        reload()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.reload() }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func reload() {
        rows = readActivity(home: home)
        table.reloadData()
    }

    func windowWillClose(_ notification: Notification) {
        timer?.invalidate()
    }

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, viewFor column: NSTableColumn?, row: Int) -> NSView? {
        let a = rows[row]
        let text: String
        switch column?.identifier.rawValue {
        case "when": text = a.when
        case "what": text = a.what
        default: text = a.file
        }
        let label = NSTextField(labelWithString: text)
        label.lineBreakMode = .byTruncatingMiddle
        label.toolTip = text
        return label
    }
}

final class Tray: NSObject, NSApplicationDelegate {
    let bin: String
    let home: String
    /// The installed program folder (.../app/current): the release number and the icons live there. nil when not given.
    let root: String?
    let started: String?
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    var state = State()
    var lastLevel = ""
    lazy var activity = ActivityWindow(home: home)

    init(bin: String, home: String, root: String?) {
        self.bin = bin
        self.home = home
        self.root = root
        self.started = Tray.readVersion(root)
    }

    /// The release this icon belongs to. The path goes through the "current" link, so after an update it answers with the new release.
    static func readVersion(_ root: String?) -> String? {
        guard let root = root, let text = try? String(contentsOfFile: root + "/VERSION", encoding: .utf8) else { return nil }
        let version = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return version.isEmpty ? nil : version
    }

    func picture(_ name: String) -> NSImage? {
        guard let root = root, let image = NSImage(contentsOfFile: "\(root)/desktop/macos/icons/\(name).png") else { return nil }
        image.size = NSSize(width: 18, height: 18)
        return image
    }

    func symbol(_ name: String?) -> NSImage? {
        guard let name = name else { return nil }
        return NSImage(systemSymbolName: name, accessibilityDescription: nil)
    }

    /// An update installed a new release under the same path: this process still runs the old code, so it builds the new source and starts again from it.
    /// An unreadable VERSION (an update in progress) or a failed build changes nothing.
    func restartIfUpdated() {
        guard let started = started, let now = Tray.readVersion(root), now != started, let root = root else { return }
        let me = CommandLine.arguments[0]
        let build = Process()
        build.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        build.arguments = ["swiftc", "-O", root + "/desktop/macos/NucleonSyncTray.swift", "-o", me + ".new"]
        build.standardOutput = FileHandle.nullDevice
        build.standardError = FileHandle.nullDevice
        guard (try? build.run()) != nil else { return }
        build.waitUntilExit()
        guard build.terminationStatus == 0, rename(me + ".new", me) == 0 else { return }
        let argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
        execv(me, argv)
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        refresh()
        Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func read() -> State {
        let url = URL(fileURLWithPath: home).appendingPathComponent("desktop.json")
        guard let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let beat = json["heartbeatAt"] as? Double,
              Date().timeIntervalSince1970 - beat / 1000 < daemonGoneSeconds,
              let view = json["view"] as? [String: Any] else { return State() }
        return State(
            level: view["level"] as? String ?? "attention",
            title: view["title"] as? String ?? "",
            lines: view["lines"] as? [String] ?? [],
            paused: json["paused"] as? Bool ?? false,
            held: json["held"] as? Int ?? 0,
            unseen: (json["unseenDeletes"] as? [Any])?.count ?? 0)
    }

    func refresh() {
        restartIfUpdated()
        state = read()
        if state.level == "stopped" && lastLevel != "stopped" && !lastLevel.isEmpty {
            notify("nucleon-sync: sync stopped", "The daemon stopped responding.")
        }
        lastLevel = state.level
        item.button?.image = statusIcon(state.level)
        item.button?.toolTip = state.title
        item.menu = menu()
    }

    func entry(_ title: String, _ action: Selector?, icon: String? = nil, image: NSImage? = nil) -> NSMenuItem {
        let m = NSMenuItem(title: title, action: action, keyEquivalent: "")
        m.target = self
        m.isEnabled = action != nil
        m.image = image ?? symbol(icon)
        return m
    }

    func menu() -> NSMenu {
        let m = NSMenu()
        m.autoenablesItems = false
        m.addItem(entry(started.map { "nucleon-sync " + $0 } ?? "nucleon-sync", nil, image: picture("nucleon-sync") ?? symbol("folder.badge.gearshape")))
        m.addItem(.separator())
        m.addItem(entry(state.title, nil, icon: menuSymbols[state.level]))
        for l in state.lines { m.addItem(entry(l, nil)) }
        m.addItem(.separator())
        if state.level != "stopped" {
            if state.paused {
                m.addItem(entry("Resume", #selector(togglePause), icon: "play.fill"))
            } else {
                m.addItem(entry("Pause", #selector(togglePause), icon: "pause.fill"))
            }
        }
        if state.held > 0 { m.addItem(entry("Approve \(state.held) deletions", #selector(approve), icon: "checkmark.circle")) }
        if state.unseen > 0 { m.addItem(entry("Mark deletions as seen", #selector(seen), icon: "checkmark")) }
        m.addItem(entry("Recent activity…", #selector(showActivity), icon: "clock.arrow.circlepath"))
        m.addItem(entry("Open folder", #selector(openFolder), icon: "folder"))
        m.addItem(entry("Open technical log", #selector(openLog), icon: "doc.text"))
        m.addItem(.separator())
        m.addItem(entry("Quit icon", #selector(quit), icon: "power"))
        return m
    }

    func run(_ path: String, _ args: [String]) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        p.environment = ProcessInfo.processInfo.environment.merging(["NUCLEON_SYNC_HOME": home]) { _, new in new }
        try? p.run()
    }

    func notify(_ title: String, _ body: String) {
        run("/usr/bin/osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body])
    }

    @objc func showActivity() { activity.show() }
    @objc func togglePause() { run(bin, [state.paused ? "resume" : "pause"]) }
    @objc func approve() { run(bin, ["approve"]) }
    @objc func seen() { run(bin, ["seen"]) }
    @objc func openLog() { NSWorkspace.shared.open(URL(fileURLWithPath: home).appendingPathComponent("nucleon-sync.log")) }
    @objc func quit() { NSApp.terminate(nil) }
    @objc func openFolder() {
        let url = URL(fileURLWithPath: home).appendingPathComponent("config.json")
        if let data = try? Data(contentsOf: url),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let root = json["localRoot"] as? String {
            NSWorkspace.shared.open(URL(fileURLWithPath: root))
        }
    }
}

let args = CommandLine.arguments
if args.count == 3 && args[1] == "--print-activity" {
    for a in readActivity(home: args[2]) { print("\(a.when) | \(a.what) | \(a.file)") }
    exit(0)
}
guard args.count == 3 || args.count == 4 else {
    print("usage: nucleon-sync-tray <path to nucleon-sync> <data folder> [<program folder>]")
    exit(1)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let tray = Tray(bin: args[1], home: args[2], root: args.count == 4 ? args[3] : nil)
app.delegate = tray
app.run()
