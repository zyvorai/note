// The native window: full-size content under a transparent title bar, a vibrancy sidebar behind the web view,
// and the message bridge the page uses to talk to AppKit (window drag, theme, sidebar width).
import Cocoa
import WebKit

extension AppDelegate: WKScriptMessageHandler {
    func buildWindow() {
        let ucc = WKUserContentController()
        ucc.add(self, name: "mac")
        // Marks the page as running inside the app so it can lay itself out under the title bar.
        ucc.addUserScript(WKUserScript(source: "document.documentElement.classList.add('mac');",
                                       injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let cfg = WKWebViewConfiguration(); cfg.userContentController = ucc
        web = WKWebView(frame: .zero, configuration: cfg)
        web.setValue(false, forKey: "drawsBackground")          // let the vibrancy show through the sidebar
        web.uiDelegate = self; web.navigationDelegate = self

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 720),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "Plainnote"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 560, height: 400)
        window.isReleasedWhenClosed = false

        let root = NSView()
        effect = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: 260, height: 720))
        effect.material = .sidebar; effect.blendingMode = .behindWindow; effect.state = .followsWindowActiveState
        effect.autoresizingMask = [.height]
        web.frame = root.bounds; web.autoresizingMask = [.width, .height]
        root.addSubview(effect); root.addSubview(web)
        window.contentView = root
        window.center()
        window.setFrameAutosaveName("NotesMain")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // performDrag needs the original mouse-down; the page's message arrives a moment later.
        NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] e in self?.lastMouseDown = e; return e }
    }

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let d = m.body as? [String: Any], let t = d["t"] as? String else { return }
        switch t {
        case "drag":
            if let e = lastMouseDown, e.window === window { window.performDrag(with: e) }
        case "zoom":
            window.performZoom(nil)
        case "theme":                                             // keep title bar and vibrancy in step with the page's theme
            switch d["v"] as? String {
            case "light": NSApp.appearance = NSAppearance(named: .aqua)
            case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
            default: NSApp.appearance = nil
            }
            DispatchQueue.main.async { [weak self] in self?.sendAccent() }
        case "side":
            let w = CGFloat((d["w"] as? NSNumber)?.doubleValue ?? 0)
            effect.isHidden = w <= 0
            effect.frame = NSRect(x: 0, y: 0, width: w, height: effect.superview?.bounds.height ?? 720)
        case "notify":                                            // sync results: only worth a banner when the app is in the background
            if !NSApp.isActive { notify(title: d["title"] as? String ?? "Plainnote", body: d["body"] as? String ?? "") }
        case "print":                                             // PDF / Print: the page has already switched to its print layout
            let info = NSPrintInfo.shared
            info.horizontalPagination = .fit
            info.isVerticallyCentered = false
            let op = web.printOperation(with: info)
            op.view?.frame = web.bounds
            op.runModal(for: window, delegate: nil, didRun: nil, contextInfo: nil)
        default: break
        }
    }
}

// MARK: toolbar and system accent colour
extension AppDelegate: NSToolbarDelegate {
    static let tbSidebar = NSToolbarItem.Identifier("sidebar"), tbNew = NSToolbarItem.Identifier("new"), tbShare = NSToolbarItem.Identifier("share")

    func buildToolbar() {
        let tb = NSToolbar(identifier: "main")
        tb.delegate = self
        tb.displayMode = .iconOnly
        window.toolbar = tb
        window.toolbarStyle = .unified
        window.titlebarSeparatorStyle = .none
    }
    func toolbarDefaultItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] {
        [Self.tbSidebar, Self.tbNew, .flexibleSpace, Self.tbShare]
    }
    func toolbarAllowedItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { toolbarDefaultItemIdentifiers(t) }
    func toolbar(_ t: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        let spec: [NSToolbarItem.Identifier: (String, String, String, Selector)] = [
            Self.tbSidebar: ("Sidebar", "sidebar.left", "Toggle Sidebar", #selector(tbSidebarTapped)),
            Self.tbNew: ("New Note", "square.and.pencil", "New Note", #selector(tbNewTapped)),
            Self.tbShare: ("Share", "square.and.arrow.up", "Share Note", #selector(shareNote)),
        ]
        guard let (label, symbol, tip, action) = spec[id] else { return nil }
        let item = NSToolbarItem(itemIdentifier: id)
        item.label = label; item.toolTip = tip; item.target = self; item.action = action
        if #available(macOS 11.0, *) { item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label) }
        else { item.title = label }
        return item
    }
    @objc func tbSidebarTapped() { js("plainnote.run('sidebar')") }
    @objc func tbNewTapped() { js("plainnote.run('new')") }

    /// Pass the system accent colour to the page, which uses it for selection, chips and primary buttons.
    func sendAccent() {
        var hex = "#5b5bd6"
        NSApp.effectiveAppearance.performAsCurrentDrawingAppearance {
            if let c = NSColor.controlAccentColor.usingColorSpace(.sRGB) {
                hex = String(format: "#%02x%02x%02x", Int(round(c.redComponent * 255)), Int(round(c.greenComponent * 255)), Int(round(c.blueComponent * 255)))
            }
        }
        js("plainnote.setAccent('\(hex)')")
    }
}
