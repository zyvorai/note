// The native menu bar. Items that act on the page call plainnote.run('<id>') (see COMMANDS in public/index.html).
import Cocoa

extension AppDelegate {
    func buildMenu() {
        let main = NSMenu()
        @discardableResult
        func add(_ menu: NSMenu, _ title: String, _ sel: Selector?, _ key: String = "", target: AnyObject? = nil, mods: NSEvent.ModifierFlags = .command, id: String? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: sel, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods; i.target = target; i.representedObject = id; menu.addItem(i); return i
        }
        func page(_ menu: NSMenu, _ title: String, _ id: String, _ key: String = "", mods: NSEvent.ModifierFlags = .command) {
            add(menu, title, #selector(run(_:)), key, target: self, mods: mods, id: id)
        }
        func submenu(_ title: String) -> NSMenu {
            let item = NSMenuItem(); main.addItem(item)
            let m = NSMenu(title: title); item.submenu = m; return m
        }

        let app = submenu("Plainnote")
        add(app, "About Plainnote", #selector(NSApplication.orderFrontStandardAboutPanel(_:)))
        app.addItem(.separator())
        add(app, "Hide Plainnote", #selector(NSApplication.hide(_:)), "h")
        add(app, "Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", mods: [.command, .option])
        add(app, "Show All", #selector(NSApplication.unhideAllApplications(_:)))
        app.addItem(.separator())
        add(app, "Quit Plainnote", #selector(NSApplication.terminate(_:)), "q")

        let file = submenu("File")
        page(file, "New Note", "new", "n")
        page(file, "Today’s Note", "today", "t", mods: [.command, .shift])
        page(file, "Open Quickly…", "switcher", "k")
        add(file, "Quick Capture…", #selector(showCapture), "n", target: self, mods: [.control, .option])
        file.addItem(.separator())
        page(file, "Export as HTML…", "export", "e", mods: [.command, .shift])
        page(file, "Export as PDF / Print…", "pdf", "p")
        page(file, "Pin / Unpin Note", "pin", "p", mods: [.command, .option])
        add(file, "Share…", #selector(shareNote), "", target: self)
        file.addItem(.separator())
        add(file, "Choose Notes Folder…", #selector(chooseFolder), "o", target: self)
        add(file, "Reveal Notes in Finder", #selector(reveal), "", target: self)
        file.addItem(.separator())
        add(file, "Close Window", #selector(NSWindow.performClose(_:)), "w")

        let edit = submenu("Edit")
        add(edit, "Undo", NSSelectorFromString("undo:"), "z")
        add(edit, "Redo", NSSelectorFromString("redo:"), "z", mods: [.command, .shift])
        edit.addItem(.separator())
        add(edit, "Cut", NSSelectorFromString("cut:"), "x")
        add(edit, "Copy", NSSelectorFromString("copy:"), "c")
        add(edit, "Paste", NSSelectorFromString("paste:"), "v")
        add(edit, "Select All", NSSelectorFromString("selectAll:"), "a")
        edit.addItem(.separator())
        page(edit, "Find and Replace…", "find", "f")
        page(edit, "Replace in All Notes…", "gfind", "h", mods: [.command, .shift])

        let view = submenu("View")
        page(view, "Edit / Preview", "toggle", "e")
        page(view, "Graph", "graph", "g")
        page(view, "Toggle Sidebar", "sidebar", "\\")
        page(view, "Focus Mode", "focus", "f", mods: [.command, .shift])
        view.addItem(.separator())
        page(view, "Cycle Theme", "theme", "l", mods: [.command, .shift])
        page(view, "Bigger Text", "bigger", "+")
        page(view, "Smaller Text", "smaller", "-")
        page(view, "Actual Size", "reset", "0")
        view.addItem(.separator())
        let bar = add(view, "Show Menu Bar Icon", #selector(toggleStatusItem(_:)), "", target: self)
        bar.state = statusItem != nil || UserDefaults.standard.object(forKey: "statusItem") as? Bool ?? true ? .on : .off
        add(view, "Reload", #selector(reload), "r", target: self)
        add(view, "Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", mods: [.command, .control])

        let go = submenu("Go")
        page(go, "Back", "back", "[")
        page(go, "Forward", "forward", "]")
        go.addItem(.separator())
        page(go, "Command Palette…", "palette", "p", mods: [.command, .shift])
        page(go, "Sync Now", "sync")
        page(go, "Trash", "trash")

        let win = submenu("Window")
        add(win, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")
        add(win, "Zoom", #selector(NSWindow.performZoom(_:)))
        win.addItem(.separator())
        add(win, "Bring All to Front", #selector(NSApplication.arrangeInFront(_:)))

        let help = submenu("Help")
        add(help, "Plainnote Website", #selector(openURL(_:)), target: self, id: "https://zyvorai.github.io/note/")
        add(help, "Report an Issue…", #selector(openURL(_:)), target: self, id: "https://github.com/zyvorai/note/issues/new/choose")

        NSApp.mainMenu = main
        NSApp.windowsMenu = win
        NSApp.helpMenu = help
    }

    @objc func openURL(_ sender: NSMenuItem) {
        if let s = sender.representedObject as? String, let u = URL(string: s) { NSWorkspace.shared.open(u) }
    }
}
