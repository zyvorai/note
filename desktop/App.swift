// Plainnote for macOS: runs server.js with the system Node and shows it in a native window (Window.swift, Menus.swift).
import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var effect: NSVisualEffectView!      // translucent sidebar behind the web view (see Window.swift)
    var lastMouseDown: NSEvent?          // used to start window drags requested by the page
    var pageReady = false                // the page finished loading; until then URL/file opens are queued
    var pending: [URL] = []
    var statusItem: NSStatusItem?
    var capture: CapturePanel?
    var server: Process?
    var stopping = false
    var port = 0

    var notesDir: String {
        get { ProcessInfo.processInfo.environment["PLAINNOTE_DIR"] ?? UserDefaults.standard.string(forKey: "notesDir") ?? NSHomeDirectory() + "/Notes" }
        set { UserDefaults.standard.set(newValue, forKey: "notesDir") }
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        buildMenu()
        buildWindow()
        buildToolbar()
        NotificationCenter.default.addObserver(forName: NSColor.systemColorsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in self?.sendAccent() }
        startServer()
        setupIntegrations()
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ n: Notification) { stopServer() }

    // MARK: server
    func findNode() -> String? {
        for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
            where FileManager.default.isExecutableFile(atPath: p) { return p }
        // Fall back to the user's login shell (covers nvm, volta, asdf…).
        let sh = Process(); sh.executableURL = URL(fileURLWithPath: "/bin/zsh")
        sh.arguments = ["-lc", "command -v node"]
        let pipe = Pipe(); sh.standardOutput = pipe; sh.standardError = FileHandle.nullDevice
        try? sh.run(); sh.waitUntilExit()
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n").last ?? ""
        return FileManager.default.isExecutableFile(atPath: out) ? out : nil
    }

    // Prefer a fixed port: the page's saved settings (theme, auto-sync) are tied to its origin, which includes the port.
    func freePort() -> Int {
        for preferred in [47878, 0] {
            let fd = socket(AF_INET, SOCK_STREAM, 0); defer { close(fd) }
            var one: Int32 = 1; setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))   // same as Node's listen(): ignore TIME_WAIT leftovers
            var addr = sockaddr_in(); addr.sin_family = sa_family_t(AF_INET)
            addr.sin_addr.s_addr = inet_addr("127.0.0.1"); addr.sin_port = UInt16(preferred).bigEndian
            addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } } == 0
            if !ok { continue }
            var len = socklen_t(MemoryLayout<sockaddr_in>.size)
            _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) } }
            return Int(UInt16(bigEndian: addr.sin_port))
        }
        return 0
    }
    func fail(_ msg: String) {
        let a = NSAlert(); a.messageText = "Plainnote can't start"; a.informativeText = msg; a.runModal()
        NSApp.terminate(nil)
    }

    func startServer() {
        guard let node = findNode() else {
            return fail("Node.js was not found. Install it from nodejs.org or with “brew install node”, then reopen Plainnote.")
        }
        guard let res = Bundle.main.resourcePath, FileManager.default.fileExists(atPath: res + "/server.js") else {
            return fail("server.js is missing from the app bundle.")
        }
        port = freePort()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [res + "/server.js", notesDir, String(port)]
        p.environment = ProcessInfo.processInfo.environment.merging(["NOTES_WATCH_STDIN": "1"]) { $1 }
        p.standardInput = Pipe(); p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
        stopping = false
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { if let s = self, !s.stopping { s.fail("The notes server stopped unexpectedly.") } }
        }
        do { try p.run() } catch { return fail("Could not start Node: \(error.localizedDescription)") }
        server = p
        waitThenLoad(tries: 60)
    }

    func stopServer() {
        pageReady = false
        stopping = true
        server?.terminate(); server = nil
    }

    func waitThenLoad(tries: Int) {
        let url = URL(string: "http://127.0.0.1:\(port)/")!
        URLSession.shared.dataTask(with: url) { [weak self] _, resp, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if (resp as? HTTPURLResponse)?.statusCode == 200 { self.web.load(URLRequest(url: url)) }
                else if tries > 0 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.waitThenLoad(tries: tries - 1) } }
                else { self.fail("The notes server did not respond.") }
            }
        }.resume()
    }

    func js(_ code: String) { web?.evaluateJavaScript(code, completionHandler: nil) }
    @objc func run(_ sender: NSMenuItem) { if let id = sender.representedObject as? String { js("plainnote.run('\(id)')") } }
    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let m = NSMenu()
        for (title, id) in [("New Note", "new"), ("Today’s Note", "today")] {
            let i = NSMenuItem(title: title, action: #selector(run(_:)), keyEquivalent: ""); i.target = self; i.representedObject = id; m.addItem(i)
        }
        return m
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window?.makeKeyAndOrderFront(nil) }
        return true
    }

    @objc func reload() { web.reload() }
    @objc func reveal() { NSWorkspace.shared.open(URL(fileURLWithPath: notesDir)) }
    @objc func chooseFolder() {
        let p = NSOpenPanel(); p.canChooseDirectories = true; p.canChooseFiles = false; p.canCreateDirectories = true
        p.prompt = "Use Folder"; p.directoryURL = URL(fileURLWithPath: notesDir)
        guard p.runModal() == .OK, let u = p.url else { return }
        notesDir = u.path
        stopServer(); startServer()
    }

    // MARK: web delegates — the UI uses confirm()/prompt(), which WKWebView ignores unless handled.
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler c: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = m
        if let w = window, w.isVisible { a.beginSheetModal(for: w) { _ in c() } } else { a.runModal(); c() }
    }
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler c: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = m
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        if let w = window, w.isVisible { a.beginSheetModal(for: w) { c($0 == .alertFirstButtonReturn) } } else { c(a.runModal() == .alertFirstButtonReturn) }
    }
    func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame f: WKFrameInfo, completionHandler c: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = prompt
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24)); field.stringValue = defaultText ?? ""
        a.accessoryView = field; a.window.initialFirstResponder = field
        if let w = window, w.isVisible { a.beginSheetModal(for: w) { c($0 == .alertFirstButtonReturn ? field.stringValue : nil) } }
        else { c(a.runModal() == .alertFirstButtonReturn ? field.stringValue : nil) }
    }
    func webView(_ w: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true
        sendAccent()
        let urls = pending; pending = []
        urls.forEach(handle)
    }
    // target=_blank links and external URLs open in the default browser.
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = a.request.url { NSWorkspace.shared.open(u) }
        return nil
    }
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = a.request.url, let h = u.host, h != "127.0.0.1" { NSWorkspace.shared.open(u); decisionHandler(.cancel) }
        else { decisionHandler(.allow) }
    }
}
