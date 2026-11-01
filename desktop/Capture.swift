// Quick capture: a small floating panel that appends a line to today's daily note without bringing the main window forward.
import Cocoa

final class CaptureTextView: NSTextView {
    var onSave: (() -> Void)?
    var onCancel: (() -> Void)?
    override func keyDown(with e: NSEvent) {
        if e.keyCode == 36 && e.modifierFlags.contains(.command) { onSave?() }       // ⌘↩
        else if e.keyCode == 53 { onCancel?() }                                       // esc
        else { super.keyDown(with: e) }
    }
}

final class CapturePanel: NSPanel, NSWindowDelegate {
    weak var app: AppDelegate?
    let text = CaptureTextView()
    let hint = NSTextField(labelWithString: "⌘↩ save to today’s note   ·   esc cancel")

    override var canBecomeKey: Bool { true }

    init(app: AppDelegate) {
        self.app = app
        super.init(contentRect: NSRect(x: 0, y: 0, width: 520, height: 170),
                   styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel], backing: .buffered, defer: false)
        isFloatingPanel = true; level = .floating; hidesOnDeactivate = false; isReleasedWhenClosed = false
        titlebarAppearsTransparent = true; titleVisibility = .hidden
        standardWindowButton(.closeButton)?.isHidden = true
        standardWindowButton(.miniaturizeButton)?.isHidden = true
        standardWindowButton(.zoomButton)?.isHidden = true
        isMovableByWindowBackground = true
        delegate = self

        let bg = NSVisualEffectView(); bg.material = .popover; bg.blendingMode = .behindWindow; bg.state = .active
        contentView = bg
        let scroll = NSScrollView(); scroll.drawsBackground = false; scroll.hasVerticalScroller = false; scroll.translatesAutoresizingMaskIntoConstraints = false
        text.isRichText = false; text.drawsBackground = false; text.font = .systemFont(ofSize: 17)
        text.textContainerInset = NSSize(width: 4, height: 4); text.isVerticallyResizable = true; text.isHorizontallyResizable = false
        text.autoresizingMask = [.width]; text.textContainer?.widthTracksTextView = true
        text.allowsUndo = true
        text.onSave = { [weak self] in self?.save() }
        text.onCancel = { [weak self] in self?.close() }
        scroll.documentView = text
        hint.font = .systemFont(ofSize: 11); hint.textColor = .secondaryLabelColor; hint.translatesAutoresizingMaskIntoConstraints = false
        bg.addSubview(scroll); bg.addSubview(hint)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: bg.topAnchor, constant: 30), scroll.leadingAnchor.constraint(equalTo: bg.leadingAnchor, constant: 18),
            scroll.trailingAnchor.constraint(equalTo: bg.trailingAnchor, constant: -18), scroll.bottomAnchor.constraint(equalTo: hint.topAnchor, constant: -8),
            hint.leadingAnchor.constraint(equalTo: bg.leadingAnchor, constant: 22), hint.bottomAnchor.constraint(equalTo: bg.bottomAnchor, constant: -12),
        ])
    }

    func present() {
        text.string = ""
        if let screen = NSScreen.main {
            let f = screen.visibleFrame
            setFrameOrigin(NSPoint(x: f.midX - frame.width / 2, y: f.minY + f.height * 0.62))
        }
        makeKeyAndOrderFront(nil)
        makeFirstResponder(text)
    }

    func windowDidResignKey(_ n: Notification) { close() }

    func save() {
        let t = text.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, let app = app else { return close() }
        let day = DateFormatter(); day.dateFormat = "yyyy-MM-dd"
        let clock = DateFormatter(); clock.dateFormat = "HH:mm"
        let body = "- \(clock.string(from: Date())) " + t.components(separatedBy: "\n").joined(separator: "\n  ")
        app.appendToNote(name: "daily/" + day.string(from: Date()), text: body) { ok in
            if ok { self.close() } else { NSSound.beep() }
        }
    }
}
