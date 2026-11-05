// Menu bar icon. Reads the daemon's desktop.json and runs proton-sync commands: all logic stays in the daemon.
// Usage: proton-sync-tray <path to proton-sync> <data folder>
import AppKit

let daemonGoneSeconds = 180.0

struct State {
    var level = "stopped"
    var title = "Synchro arrêtée"
    var lines: [String] = ["Le démon ne tourne pas."]
    var paused = false
    var held = 0
    var unseen = 0
}

final class Tray: NSObject, NSApplicationDelegate {
    let bin: String
    let home: String
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    var state = State()
    var lastLevel = ""

    init(bin: String, home: String) {
        self.bin = bin
        self.home = home
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
        state = read()
        if state.level == "stopped" && lastLevel != "stopped" && !lastLevel.isEmpty {
            notify("proton-sync : synchro arrêtée", "Le démon ne répond plus.")
        }
        lastLevel = state.level
        let symbols = ["ok": "checkmark.icloud", "syncing": "arrow.triangle.2.circlepath.icloud", "paused": "pause.circle",
                       "attention": "exclamationmark.icloud", "stopped": "xmark.icloud"]
        item.button?.image = NSImage(systemSymbolName: symbols[state.level] ?? "icloud", accessibilityDescription: state.title)
        item.menu = menu()
    }

    func entry(_ title: String, _ action: Selector?) -> NSMenuItem {
        let m = NSMenuItem(title: title, action: action, keyEquivalent: "")
        m.target = self
        m.isEnabled = action != nil
        return m
    }

    func menu() -> NSMenu {
        let m = NSMenu()
        m.autoenablesItems = false
        m.addItem(entry(state.title, nil))
        for l in state.lines { m.addItem(entry(l, nil)) }
        m.addItem(.separator())
        if state.level != "stopped" {
            m.addItem(entry(state.paused ? "Reprendre" : "Mettre en pause", #selector(togglePause)))
        }
        if state.held > 0 { m.addItem(entry("Valider \(state.held) suppressions", #selector(approve))) }
        if state.unseen > 0 { m.addItem(entry("Marquer les suppressions comme vues", #selector(seen))) }
        m.addItem(entry("Ouvrir le dossier", #selector(openFolder)))
        m.addItem(entry("Ouvrir le journal", #selector(openLog)))
        m.addItem(.separator())
        m.addItem(entry("Quitter l'icône", #selector(quit)))
        return m
    }

    func run(_ path: String, _ args: [String]) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        p.environment = ProcessInfo.processInfo.environment.merging(["PROTON_SYNC_HOME": home]) { _, new in new }
        try? p.run()
    }

    func notify(_ title: String, _ body: String) {
        run("/usr/bin/osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body])
    }

    @objc func togglePause() { run(bin, [state.paused ? "resume" : "pause"]) }
    @objc func approve() { run(bin, ["approve"]) }
    @objc func seen() { run(bin, ["seen"]) }
    @objc func openLog() { NSWorkspace.shared.open(URL(fileURLWithPath: home).appendingPathComponent("proton-sync.log")) }
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
guard args.count == 3 else {
    print("usage: proton-sync-tray <path to proton-sync> <data folder>")
    exit(1)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let tray = Tray(bin: args[1], home: args[2])
app.delegate = tray
app.run()
