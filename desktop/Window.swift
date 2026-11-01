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
        case "side":
            let w = CGFloat((d["w"] as? NSNumber)?.doubleValue ?? 0)
            effect.isHidden = w <= 0
            effect.frame = NSRect(x: 0, y: 0, width: w, height: effect.superview?.bounds.height ?? 720)
        default: break
        }
    }
}
