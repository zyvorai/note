// File operations on the notes folder: a Swift port of the rules in server.js (path confinement, conflict detection on
// save, the .trash folder, folders, image uploads, CSS snippets). Foundation only, so it is unit-testable without a UI.
import Foundation

enum StoreError: Error, Equatable {
    case badName, badPath, conflict, exists, notEmpty, notFound, tooLarge, badImage

    var status: Int {
        switch self {
        case .badName, .badPath, .badImage: return 400
        case .conflict, .exists, .notEmpty: return 409
        case .notFound: return 404
        case .tooLarge: return 413
        }
    }
    var message: String {
        switch self {
        case .badName: return "bad name"
        case .badPath: return "bad path"
        case .conflict: return "conflict"
        case .exists: return "exists"
        case .notEmpty: return "not empty"
        case .notFound: return "not found"
        case .tooLarge: return "file too large (20MB max)"
        case .badImage: return "unsupported image type"
        }
    }
}

final class NotesStore {
    static let imageTypes: [String: String] = [
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp", "svg": "image/svg+xml", "heic": "image/heic",
    ]
    let root: URL
    private let rootPath: String
    private let fm = FileManager.default

    init(root: URL) {
        self.root = root.standardizedFileURL
        self.rootPath = self.root.path
        try? fm.createDirectory(at: self.root, withIntermediateDirectories: true)
    }

    private var trashDir: URL { root.appendingPathComponent(".trash") }
    private var snippetsDir: URL { root.appendingPathComponent(".plainnote/snippets") }

    // MARK: paths (lexical confinement, exactly like notePath/folderPath in server.js)
    private func inside(_ u: URL) -> Bool { u.standardizedFileURL.path.hasPrefix(rootPath + "/") }

    func notePath(_ name: String) throws -> URL {
        guard !name.isEmpty, !name.contains("\0") else { throw StoreError.badName }
        var n = name
        if n.lowercased().hasSuffix(".md") { n = String(n.dropLast(3)) }
        let u = URL(fileURLWithPath: rootPath + "/" + n + ".md").standardizedFileURL
        guard inside(u) else { throw StoreError.badPath }
        return u
    }
    func folderPath(_ name: String) throws -> URL {
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty, !name.contains("\0") else { throw StoreError.badName }
        let parts = name.replacingOccurrences(of: "\\", with: "/").split(separator: "/").map(String.init)
        guard !parts.isEmpty, !parts.contains(where: { $0 == "." || $0 == ".." || $0.hasPrefix(".") }) else { throw StoreError.badName }
        let u = URL(fileURLWithPath: rootPath + "/" + parts.joined(separator: "/")).standardizedFileURL
        guard inside(u) else { throw StoreError.badPath }
        return u
    }

    private func mtimeMs(_ u: URL) -> Double? {
        guard let d = (try? fm.attributesOfItem(atPath: u.path))?[.modificationDate] as? Date else { return nil }
        return (d.timeIntervalSince1970 * 1000).rounded(.down)
    }
    private func nowMs() -> Int { Int((Date().timeIntervalSince1970 * 1000).rounded()) }
    private func mkdirs(_ u: URL) throws { try fm.createDirectory(at: u, withIntermediateDirectories: true) }

    /// Writes through NSFileCoordinator so iCloud Drive / File Provider folders stay consistent.
    private func coordinatedWrite(_ u: URL, _ body: (URL) throws -> Void) throws {
        var err: NSError?, thrown: Error?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: u, options: .forReplacing, error: &err) { target in
            do { try body(target) } catch { thrown = error }
        }
        if let e = thrown ?? err { throw e }
    }

    // MARK: notes
    func listNotes() throws -> [[String: Any]] {
        var out: [[String: Any]] = []
        func walk(_ dir: URL, _ base: String) throws {
            for u in try fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.isDirectoryKey], options: []) {
                let name = u.lastPathComponent
                if name.hasPrefix(".") { continue }
                let rel = base.isEmpty ? name : base + "/" + name
                let isDir = (try? u.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
                if isDir == true { try walk(u, rel) }
                else if name.lowercased().hasSuffix(".md") {
                    let text = (try? Data(contentsOf: u)).map { String(decoding: $0, as: UTF8.self) } ?? ""
                    out.append(["name": String(rel.dropLast(3)), "text": text, "mtime": mtimeMs(u) ?? 0])
                }
            }
        }
        try walk(root, "")
        return out
    }

    /// Returns the new mtime. `base` is the client's last known mtime; a newer file on disk means someone else changed it.
    func writeNote(_ name: String, _ text: String, base: Double?) throws -> Double {
        let p = try notePath(name)
        if let base, let st = mtimeMs(p), st > base + 1 { throw StoreError.conflict }
        try mkdirs(p.deletingLastPathComponent())
        try coordinatedWrite(p) { try Data(text.utf8).write(to: $0, options: .atomic) }
        return mtimeMs(p) ?? 0
    }

    func deleteNote(_ name: String) throws {                       // move to .trash instead of destroying
        let p = try notePath(name)
        guard fm.fileExists(atPath: p.path) else { throw StoreError.notFound }
        var n = name; if n.lowercased().hasSuffix(".md") { n = String(n.dropLast(3)) }
        try mkdirs(trashDir)
        try coordinatedWrite(p) { try fm.moveItem(at: $0, to: trashDir.appendingPathComponent("\(nowMs())__\(Self.encodeURIComponent(n)).md")) }
    }

    func rename(_ from: String, _ to: String) throws {
        let a = try notePath(from), b = try notePath(to)
        if fm.fileExists(atPath: b.path) { throw StoreError.exists }
        guard fm.fileExists(atPath: a.path) else { throw StoreError.notFound }
        try mkdirs(b.deletingLastPathComponent())
        try coordinatedWrite(a) { try fm.moveItem(at: $0, to: b) }
    }

    func append(_ name: String, _ text: String) throws -> Double {
        let p = try notePath(name)
        try mkdirs(p.deletingLastPathComponent())
        let prev = (try? Data(contentsOf: p)).map { String(decoding: $0, as: UTF8.self) } ?? ""
        var add = text; while add.hasSuffix("\n") { add.removeLast() }
        let combined = prev + (!prev.isEmpty && !prev.hasSuffix("\n") ? "\n" : "") + add + "\n"
        try coordinatedWrite(p) { try Data(combined.utf8).write(to: $0, options: .atomic) }
        return mtimeMs(p) ?? 0
    }

    // MARK: trash
    func trashItems() -> [[String: Any]] {
        let files = (try? fm.contentsOfDirectory(atPath: trashDir.path)) ?? []
        return files.filter { $0.range(of: #"^\d+__.+\.md$"#, options: .regularExpression) != nil }.sorted().reversed().map { f in
            let i = f.range(of: "__")!
            let name = String(f[i.upperBound...].dropLast(3)).removingPercentEncoding ?? String(f[i.upperBound...].dropLast(3))
            return ["id": f, "deleted": Int(f[..<i.lowerBound]) ?? 0, "name": name]
        }
    }
    func emptyTrash() { try? fm.removeItem(at: trashDir) }
    func restore(_ id: String) throws -> String {
        guard id.range(of: #"^\d+__[^/\\]+\.md$"#, options: .regularExpression) != nil else { throw StoreError.badName }
        let i = id.range(of: "__")!
        var name = String(id[i.upperBound...].dropLast(3)).removingPercentEncoding ?? ""
        guard !name.isEmpty else { throw StoreError.badName }
        while fm.fileExists(atPath: try notePath(name).path) { name += " (restored)" }
        let dest = try notePath(name)
        try mkdirs(dest.deletingLastPathComponent())
        let src = trashDir.appendingPathComponent(id)
        guard fm.fileExists(atPath: src.path) else { throw StoreError.notFound }
        try fm.moveItem(at: src, to: dest)
        return name
    }

    // MARK: folders
    func listFolders() -> [String] {
        var out: [String] = []
        func walk(_ dir: URL, _ base: String) {
            for u in (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.isDirectoryKey], options: [])) ?? [] {
                let name = u.lastPathComponent
                guard !name.hasPrefix("."), (try? u.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else { continue }
                let rel = base.isEmpty ? name : base + "/" + name
                out.append(rel); walk(u, rel)
            }
        }
        walk(root, ""); return out.sorted()
    }
    func makeFolder(_ name: String) throws { try mkdirs(try folderPath(name)) }
    func removeFolder(_ name: String) throws {                      // only empty folders: notes are never removed this way
        let p = try folderPath(name)
        guard let items = try? fm.contentsOfDirectory(atPath: p.path) else { throw StoreError.notFound }
        guard items.isEmpty else { throw StoreError.notEmpty }
        try fm.removeItem(at: p)
    }

    // MARK: images
    func upload(_ name: String, _ data: Data) throws -> String {
        guard data.count <= 20_000_000 else { throw StoreError.tooLarge }
        let base = (name.isEmpty ? "image.png" : name).split(separator: "/").last.map(String.init) ?? "image.png"
        let ext = (base as NSString).pathExtension.lowercased()
        guard Self.imageTypes[ext] != nil else { throw StoreError.badImage }
        var stem = String(base.dropLast(ext.count + 1)).replacingOccurrences(of: #"[^\w.-]+"#, with: "-", options: .regularExpression)
        stem = String(stem.prefix(60)); if stem.isEmpty { stem = "image" }
        let rel = "attachments/\(nowMs())-\(stem).\(ext)"
        try mkdirs(root.appendingPathComponent("attachments"))
        try data.write(to: root.appendingPathComponent(rel), options: .atomic)
        return rel
    }
    /// Image bytes + MIME type for /files/<rel>; nothing but images inside the notes folder is ever served.
    func file(_ rel: String) throws -> (Data, String) {
        let u = URL(fileURLWithPath: rootPath + "/" + rel).standardizedFileURL
        guard inside(u), let type = Self.imageTypes[u.pathExtension.lowercased()], let d = try? Data(contentsOf: u) else { throw StoreError.notFound }
        return (d, type)
    }

    // MARK: CSS snippets (<notes>/.plainnote/snippets/*.css; plain file names only)
    static func validSnippet(_ n: String) -> Bool { n.range(of: #"^\w[\w .-]*\.css$"#, options: .regularExpression) != nil }
    func listSnippets() -> [[String: String]] {
        ((try? fm.contentsOfDirectory(atPath: snippetsDir.path)) ?? []).filter(Self.validSnippet).sorted().map { ["name": $0] }
    }
    func snippet(_ name: String) throws -> String {
        guard Self.validSnippet(name) else { throw StoreError.badName }
        guard let d = try? Data(contentsOf: snippetsDir.appendingPathComponent(name)) else { throw StoreError.notFound }
        return String(decoding: d, as: UTF8.self)
    }

    // JavaScript's encodeURIComponent, so trash file names match the ones the Node server writes.
    static func encodeURIComponent(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")) ?? s
    }
}
