// Minimal macOS wrapper: runs server.js with the system Node and shows it in a WKWebView.
import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?
    var stopping = false
    var port = 0

    var notesDir: String {
        get { UserDefaults.standard.string(forKey: "notesDir") ?? NSHomeDirectory() + "/Notes" }
        set { UserDefaults.standard.set(newValue, forKey: "notesDir") }
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        buildMenu()
        buildWindow()
        startServer()
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

    func freePort() -> Int {
        let fd = socket(AF_INET, SOCK_STREAM, 0); defer { close(fd) }
        var addr = sockaddr_in(); addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1"); addr.sin_port = 0
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) } }
        return Int(UInt16(bigEndian: addr.sin_port))
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

    // MARK: window
    func buildWindow() {
        let cfg = WKWebViewConfiguration()
        web = WKWebView(frame: .zero, configuration: cfg)
        web.uiDelegate = self; web.navigationDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 720),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Plainnote"
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("NotesMain")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: menus
    func buildMenu() {
        let main = NSMenu()
        func add(_ menu: NSMenu, _ title: String, _ sel: Selector?, _ key: String = "", target: AnyObject? = nil, mods: NSEvent.ModifierFlags = .command) {
            let i = NSMenuItem(title: title, action: sel, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods; i.target = target; menu.addItem(i)
        }
        func submenu(_ title: String) -> NSMenu {
            let item = NSMenuItem(); main.addItem(item)
            let m = NSMenu(title: title); item.submenu = m; return m
        }
        let app = submenu("Plainnote")
        add(app, "Hide Plainnote", #selector(NSApplication.hide(_:)), "h")
        app.addItem(.separator())
        add(app, "Quit Plainnote", #selector(NSApplication.terminate(_:)), "q")

        let file = submenu("File")
        add(file, "Choose Notes Folder…", #selector(chooseFolder), "o", target: self)
        add(file, "Reveal Notes in Finder", #selector(reveal), "", target: self)
        add(file, "Close Window", #selector(NSWindow.performClose(_:)), "w")

        let edit = submenu("Edit")
        add(edit, "Undo", NSSelectorFromString("undo:"), "z")
        add(edit, "Redo", NSSelectorFromString("redo:"), "z", mods: [.command, .shift])
        edit.addItem(.separator())
        add(edit, "Cut", NSSelectorFromString("cut:"), "x")
        add(edit, "Copy", NSSelectorFromString("copy:"), "c")
        add(edit, "Paste", NSSelectorFromString("paste:"), "v")
        add(edit, "Select All", NSSelectorFromString("selectAll:"), "a")

        let view = submenu("View")
        add(view, "Reload", #selector(reload), "r", target: self)
        add(view, "Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", mods: [.command, .control])

        let win = submenu("Window")
        add(win, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")
        NSApp.mainMenu = main
        NSApp.windowsMenu = win
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
        let a = NSAlert(); a.messageText = m; a.runModal(); c()
    }
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler c: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = m
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        c(a.runModal() == .alertFirstButtonReturn)
    }
    func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame f: WKFrameInfo, completionHandler c: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = prompt
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24)); field.stringValue = defaultText ?? ""
        a.accessoryView = field; a.window.initialFirstResponder = field
        c(a.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
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

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
