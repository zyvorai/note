// Hosts the web UI (public/) in a WKWebView with no server: static files come from the app bundle through a custom URL
// scheme, and the page's fetch('/api/…') calls are answered natively by Router (a JS shim forwards them through a
// message handler, because WKURLSchemeHandler cannot see request bodies reliably). Notes live in a folder chosen by the
// user (any Files location, e.g. iCloud Drive) or in the app's own Documents/Notes.
import SwiftUI
import UIKit
import WebKit

enum NotesLocation {
    static let key = "notesBookmark"
    /// The notes folder and, when it came from the folder picker, the URL whose security scope must stay open.
    static func resolve() -> (root: URL, scoped: URL?) {
        if let dir = ProcessInfo.processInfo.environment["PLAINNOTE_DIR"] { return (URL(fileURLWithPath: dir), nil) }
        if let data = UserDefaults.standard.data(forKey: key) {
            var stale = false
            if let u = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale), u.startAccessingSecurityScopedResource() { return (u, u) }
        }
        return (FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Notes"), nil)
    }
}

final class WebHost: NSObject, ObservableObject {
    static let scheme = "pnapp"
    static let appURL = URL(string: "pnapp://local/index.html")!

    private(set) var store: NotesStore
    private var router: Router
    private var scoped: URL?
    private(set) var web: WKWebView!
    private var pageReady = false
    private var pending: [URL] = []
    private var started = false

    override init() {
        let loc = NotesLocation.resolve()
        store = NotesStore(root: loc.root); router = Router(store: store); scoped = loc.scoped
        super.init()
    }

    func start() {
        guard !started else { return }; started = true
        let ucc = WKUserContentController()
        ucc.addUserScript(WKUserScript(source: Self.bridgeJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ucc.addScriptMessageHandler(self, contentWorld: .page, name: "api")
        ucc.add(self, name: "mac")                                    // the page's macPost(): theme, print, chooseFolder, …
        let cfg = WKWebViewConfiguration()
        cfg.userContentController = ucc
        cfg.setURLSchemeHandler(self, forURLScheme: Self.scheme)
        cfg.allowsInlineMediaPlayback = true
        web = WKWebView(frame: .zero, configuration: cfg)
        web.uiDelegate = self; web.navigationDelegate = self
        web.isOpaque = false; web.backgroundColor = .clear; web.scrollView.backgroundColor = .clear
        web.scrollView.contentInsetAdjustmentBehavior = .never      // the page handles safe areas itself (env(safe-area-inset-*))
        web.scrollView.keyboardDismissMode = .interactive
        web.scrollView.bounces = false
        if #available(iOS 16.4, *) { web.isInspectable = true }
        for n in [UIResponder.keyboardWillChangeFrameNotification, UIResponder.keyboardWillHideNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)), name: n, object: nil)
        }
        web.load(URLRequest(url: Self.appURL))
    }

    /// Tells the page how much of the web view the keyboard covers, so the layout shrinks above it.
    @objc private func keyboardChanged(_ n: Notification) {
        var overlap: CGFloat = 0
        if n.name == UIResponder.keyboardWillChangeFrameNotification, let end = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue, let web {
            overlap = max(0, web.convert(web.bounds, to: nil).maxY - end.minY)
        }
        js("plainnote.setKeyboard(\(Int(overlap.rounded())))")
    }
    private func haptic(_ kind: String) {
        switch kind {
        case "selection": UISelectionFeedbackGenerator().selectionChanged()
        case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
        case "warning": UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case "medium": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        case "heavy": UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        default: UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
    }

    // MARK: JS bridge
    /// Marks the page as the iOS app and routes same-origin fetch('/api/…') to the native router.
    static let bridgeJS = """
    (function () {
      var root = document.documentElement; root.classList.add('ios'); root.classList.add('touch');
      var b64 = function (buf) { var s = '', u = new Uint8Array(buf), n = 0x8000; for (var i = 0; i < u.length; i += n) s += String.fromCharCode.apply(null, u.subarray(i, i + n)); return btoa(s); };
      var unb64 = function (s) { var bin = atob(s), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
      var orig = window.fetch.bind(window);
      window.fetch = async function (input, init) {
        init = init || {};
        var url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (url.origin !== location.origin || url.pathname.indexOf('/api/') !== 0) return orig(input, init);
        var headers = {}; new Headers(init.headers || {}).forEach(function (v, k) { headers[k] = v; });
        var body = null;
        if (init.body != null) body = typeof init.body === 'string' ? b64(new TextEncoder().encode(init.body)) : b64(await new Response(init.body).arrayBuffer());
        var r = await window.webkit.messageHandlers.api.postMessage({ method: (init.method || 'GET').toUpperCase(), url: url.pathname + url.search, headers: headers, body: body });
        return new Response(r.status === 204 ? null : unb64(r.body), { status: r.status, headers: r.headers });
      };
    })();
    """

    func js(_ code: String) { web?.evaluateJavaScript(code, completionHandler: nil) }
    func jsString(_ s: String) -> String {
        (try? JSONSerialization.data(withJSONObject: s, options: [.fragmentsAllowed])).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
    }

    // MARK: plainnote://open/<note>   plainnote://today   plainnote://new?title=&text=
    func handle(_ url: URL) {
        guard url.scheme == "plainnote" else { return }
        guard pageReady else { pending.append(url); return }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func val(_ k: String) -> String? { items.first { $0.name == k }?.value }
        switch url.host ?? "" {
        case "open":
            let name = String(url.path.dropFirst()).removingPercentEncoding ?? ""
            if !name.isEmpty { js("plainnote.openNote(\(jsString(name)), false)") }
        case "today": js("plainnote.run('today')")
        case "new":
            let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HHmmss"
            let title = val("title")?.isEmpty == false ? val("title")! : "Untitled " + f.string(from: Date())
            let payload = (try? JSONSerialization.data(withJSONObject: ["name": title, "text": val("text") ?? ""])) ?? Data()
            if router.handle(APIRequest(method: "POST", path: "/api/append", body: payload)).status == 200 { js("plainnote.openNote(\(jsString(title)), true)") }
        default: break
        }
    }

    // MARK: notes folder
    func chooseFolder() {
        let p = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
        p.delegate = self; p.directoryURL = store.root
        Self.top()?.present(p, animated: true)
    }
    func useFolder(_ url: URL) {
        guard url.startAccessingSecurityScopedResource() else { return alert("Plainnote can’t open that folder.") }
        if let data = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) { UserDefaults.standard.set(data, forKey: NotesLocation.key) }
        scoped?.stopAccessingSecurityScopedResource(); scoped = url
        store = NotesStore(root: url); router = Router(store: store)
        pageReady = false; web.load(URLRequest(url: Self.appURL))
    }

    // MARK: UIKit helpers
    static func top() -> UIViewController? {
        var v = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap { $0.windows }.first { $0.isKeyWindow }?.rootViewController
        while let p = v?.presentedViewController { v = p }
        return v
    }
    func alert(_ message: String) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default)); Self.top()?.present(a, animated: true)
    }
    private func setTheme(_ v: String?) {
        let style: UIUserInterfaceStyle = v == "light" ? .light : v == "dark" ? .dark : .unspecified
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap { $0.windows }.forEach { $0.overrideUserInterfaceStyle = style }
    }
    private func share(name: String, html: String) {
        let safe = name.replacingOccurrences(of: "/", with: "-")
        let u = FileManager.default.temporaryDirectory.appendingPathComponent(safe + ".html")
        guard (try? html.write(to: u, atomically: true, encoding: .utf8)) != nil, let top = Self.top() else { return }
        let a = UIActivityViewController(activityItems: [u], applicationActivities: nil)
        a.popoverPresentationController?.sourceView = top.view
        a.popoverPresentationController?.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 1, height: 1)
        top.present(a, animated: true)
    }
    private func printPage() {
        let c = UIPrintInteractionController.shared
        let info = UIPrintInfo(dictionary: nil); info.outputType = .general; info.jobName = "Plainnote"
        c.printInfo = info; c.printFormatter = web.viewPrintFormatter(); c.present(animated: true)
    }
}

// MARK: static files + images from the notes folder
extension WebHost: WKURLSchemeHandler {
    private static let mime = ["html": "text/html; charset=utf-8", "js": "text/javascript", "css": "text/css", "svg": "image/svg+xml", "json": "application/json",
                               "webmanifest": "application/manifest+json", "png": "image/png", "ico": "image/x-icon"]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return task.didFailWithError(URLError(.badURL)) }
        var path = url.path.removingPercentEncoding ?? url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        func reply(_ code: Int, _ type: String, _ data: Data, _ extra: [String: String] = [:]) {
            var h = ["Content-Type": type, "Content-Length": String(data.count), "Cache-Control": "no-store"]; extra.forEach { h[$0.key] = $0.value }
            task.didReceive(HTTPURLResponse(url: url, statusCode: code, httpVersion: "HTTP/1.1", headerFields: h)!)
            task.didReceive(data); task.didFinish()
        }
        if path.hasPrefix("/files/") {                                // images in the notes folder (SVGs are sandboxed, as on the Node server)
            if let (d, type) = try? store.file(String(path.dropFirst(7))) {
                return reply(200, type, d, ["Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'", "X-Content-Type-Options": "nosniff"])
            }
            return reply(404, "application/json", Data(#"{"error":"not found"}"#.utf8))
        }
        let base = Bundle.main.resourceURL!.appendingPathComponent("public").standardizedFileURL
        let file = base.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard !path.contains(".."), file.path.hasPrefix(base.path + "/"), let d = try? Data(contentsOf: file) else {
            return reply(404, "application/json", Data(#"{"error":"not found"}"#.utf8))
        }
        reply(200, Self.mime[file.pathExtension.lowercased()] ?? "application/octet-stream", d)
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

// MARK: messages from the page
extension WebHost: WKScriptMessageHandlerWithReply, WKScriptMessageHandler {
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let d = m.body as? [String: Any], let method = d["method"] as? String, let url = d["url"] as? String else { return replyHandler(nil, "bad request") }
        let headers = d["headers"] as? [String: String] ?? [:]
        let body = (d["body"] as? String).flatMap { Data(base64Encoded: $0) } ?? Data()
        let router = self.router
        DispatchQueue.global(qos: .userInitiated).async {
            let r = router.handle(APIRequest(method: method, url: url, headers: headers, body: body))
            DispatchQueue.main.async { replyHandler(["status": r.status, "headers": r.headers, "body": r.body.base64EncodedString()], nil) }
        }
    }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let d = m.body as? [String: Any], let t = d["t"] as? String else { return }
        switch t {
        case "theme": setTheme(d["v"] as? String)
        case "haptic": haptic(d["v"] as? String ?? "light")
        case "chooseFolder": chooseFolder()
        case "print": printPage()
        case "shareHTML": share(name: d["name"] as? String ?? "note", html: d["html"] as? String ?? "")
        case "selftest": SelfTest.record(d["result"] as? String ?? "", in: store.root)
        default: break
        }
    }
}

// MARK: navigation, JS dialogs (WKWebView shows none unless asked), folder picker
extension WebHost: WKNavigationDelegate, WKUIDelegate, UIDocumentPickerDelegate {
    func webView(_ w: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true
        if let u = ProcessInfo.processInfo.environment["PLAINNOTE_URL"].flatMap(URL.init(string:)) { pending.append(u) }   // handy for screenshots: launch straight into a note
        if let code = ProcessInfo.processInfo.environment["PLAINNOTE_EVAL"] { DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.js(code) } }   // for screenshots and demos
        let urls = pending; pending = []; urls.forEach(handle)
        SelfTest.runIfRequested(on: self)
    }
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = a.request.url, let s = u.scheme, s != Self.scheme, s != "about", s != "blob", s != "data" { UIApplication.shared.open(u); return decisionHandler(.cancel) }
        decisionHandler(.allow)
    }
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = a.request.url { UIApplication.shared.open(u) }
        return nil
    }
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler c: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: m, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in c() }); Self.top()?.present(a, animated: true)
    }
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler c: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: m, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in c(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in c(true) }); Self.top()?.present(a, animated: true)
    }
    func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt p: String, defaultText: String?, initiatedByFrame f: WKFrameInfo, completionHandler c: @escaping (String?) -> Void) {
        let a = UIAlertController(title: nil, message: p, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText }
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in c(nil) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in c(a.textFields?.first?.text) }); Self.top()?.present(a, animated: true)
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { if let u = urls.first { useFolder(u) } }
}
