// Talks to the rest of macOS: plainnote:// URLs, opening .md files and folders, the Services menu,
// Share, notifications, the menu-bar item and the global quick-capture hotkey.
import Cocoa
import Carbon.HIToolbox
import UserNotifications

extension AppDelegate {
    func setupIntegrations() {
        NSApp.servicesProvider = self
        NSUpdateDynamicServices()
        if UserDefaults.standard.object(forKey: "statusItem") as? Bool ?? true { addStatusItem() }
        registerHotKey()
    }

    // MARK: URLs and files
    func application(_ app: NSApplication, open urls: [URL]) {
        if pageReady { urls.forEach(handle) } else { pending.append(contentsOf: urls) }
        if pageReady { window?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    }

    func jsString(_ s: String) -> String {
        (try? JSONSerialization.data(withJSONObject: s, options: [.fragmentsAllowed])).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
    }

    /// plainnote://open/<note>   plainnote://today   plainnote://new?title=&text=   or a file/folder URL
    func handle(_ url: URL) {
        if url.isFileURL { return openFile(url) }
        guard url.scheme == "plainnote" else { return }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func val(_ k: String) -> String? { items.first { $0.name == k }?.value }
        switch url.host ?? "" {
        case "open":
            let name = String(url.path.dropFirst()).removingPercentEncoding ?? ""
            if !name.isEmpty { js("plainnote.openNote(\(jsString(name)), false)") }
        case "today":
            js("plainnote.run('today')")
        case "new":
            let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HHmmss"
            let title = (val("title")?.isEmpty == false ? val("title")! : "Untitled " + f.string(from: Date()))
            appendToNote(name: title, text: val("text") ?? "") { ok in
                if ok { self.js("plainnote.openNote(\(self.jsString(title)), true)") }
            }
        default: break
        }
    }

    func openFile(_ u: URL) {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: u.path, isDirectory: &isDir) else { return }
        if isDir.boolValue { return useFolder(u.path) }
        let root = URL(fileURLWithPath: notesDir).resolvingSymlinksInPath().path + "/"
        let p = u.resolvingSymlinksInPath().path
        if p.hasPrefix(root) {
            var name = String(p.dropFirst(root.count))
            if name.lowercased().hasSuffix(".md") { name = String(name.dropLast(3)) }
            js("plainnote.openNote(\(jsString(name)), false)")
        } else {
            let a = NSAlert(); a.messageText = "Open “\(u.lastPathComponent)”?"
            a.informativeText = "It isn’t in your notes folder. Plainnote can use its folder (\(u.deletingLastPathComponent().lastPathComponent)) as the notes folder."
            a.addButton(withTitle: "Use Folder"); a.addButton(withTitle: "Cancel")
            guard a.runModal() == .alertFirstButtonReturn else { return }
            pending.append(u)
            useFolder(u.deletingLastPathComponent().path)
        }
    }

    func useFolder(_ path: String) {
        notesDir = path
        stopServer(); startServer()
    }

    /// POST /api/append on the local server (quick capture, URL scheme, Services).
    func appendToNote(name: String, text: String, done: ((Bool) -> Void)? = nil) {
        guard port > 0, let url = URL(string: "http://127.0.0.1:\(port)/api/append"),
              let body = try? JSONSerialization.data(withJSONObject: ["name": name, "text": text]) else { done?(false); return }
        var r = URLRequest(url: url); r.httpMethod = "POST"; r.httpBody = body
        URLSession.shared.dataTask(with: r) { _, resp, _ in
            DispatchQueue.main.async { done?((resp as? HTTPURLResponse)?.statusCode == 200) }
        }.resume()
    }

    // MARK: Services ("New Plainnote from Selection") and Share
    @objc func newNoteFromSelection(_ pboard: NSPasteboard, userData: String, error: AutoreleasingUnsafeMutablePointer<NSString>) {
        guard let text = pboard.string(forType: .string), !text.isEmpty else { return }
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HHmm"
        let name = "Clippings/" + f.string(from: Date())
        appendToNote(name: name, text: text) { ok in
            guard ok else { return }
            self.window?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
            self.js("plainnote.openNote(\(self.jsString(name)), false)")
        }
    }

    @objc func shareNote() {
        web.evaluateJavaScript("JSON.stringify(plainnote.current())") { r, _ in
            guard let s = r as? String, let d = s.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: String],
                  let text = o["text"] else { NSSound.beep(); return }
            let tmp = FileManager.default.temporaryDirectory.appendingPathComponent((o["name"] ?? "note").replacingOccurrences(of: "/", with: "-") + ".md")
            try? text.write(to: tmp, atomically: true, encoding: .utf8)
            NSSharingServicePicker(items: [tmp]).show(relativeTo: .zero, of: self.web, preferredEdge: .minY)
        }
    }

    // MARK: notifications
    func notify(title: String, body: String) {
        let c = UNUserNotificationCenter.current()
        c.requestAuthorization(options: [.alert]) { granted, _ in
            guard granted else { return }
            let n = UNMutableNotificationContent(); n.title = title; n.body = body
            c.add(UNNotificationRequest(identifier: UUID().uuidString, content: n, trigger: nil))
        }
    }

    // MARK: menu-bar item
    func addStatusItem() {
        let it = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let b = it.button {
            let img = NSImage(systemSymbolName: "note.text", accessibilityDescription: "Plainnote")
            img?.isTemplate = true; b.image = img
        }
        let m = NSMenu()
        for (title, sel, key) in [("Quick Capture…", #selector(showCapture), "n"), ("New Note", #selector(statusNew), ""),
                                  ("Today’s Note", #selector(statusToday), ""), ("Open Plainnote", #selector(showMain), "")] {
            let i = NSMenuItem(title: title, action: sel, keyEquivalent: key); i.target = self
            if key == "n" { i.keyEquivalentModifierMask = [.control, .option] }
            m.addItem(i)
        }
        m.addItem(.separator())
        m.addItem(NSMenuItem(title: "Quit Plainnote", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        it.menu = m
        statusItem = it
    }
    @objc func toggleStatusItem(_ sender: NSMenuItem) {
        if let it = statusItem { NSStatusBar.system.removeStatusItem(it); statusItem = nil }
        else { addStatusItem() }
        UserDefaults.standard.set(statusItem != nil, forKey: "statusItem")
        sender.state = statusItem != nil ? .on : .off
    }
    @objc func showMain() { window?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc func statusNew() { showMain(); js("plainnote.run('new')") }
    @objc func statusToday() { showMain(); js("plainnote.run('today')") }

    // MARK: quick capture (global hotkey ⌃⌥N)
    @objc func showCapture() {
        if capture == nil { capture = CapturePanel(app: self) }
        capture?.present()
    }

    func registerHotKey() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            DispatchQueue.main.async { delegate.showCapture() }
            return noErr
        }, 1, &spec, nil, nil)
        var ref: EventHotKeyRef?
        let id = EventHotKeyID(signature: OSType(0x504C4E54), id: 1)             // 'PLNT'
        RegisterEventHotKey(UInt32(kVK_ANSI_N), UInt32(controlKey | optionKey), id, GetApplicationEventTarget(), 0, &ref)
    }
}
