// The same /api/* routes (and JSON shapes and status codes) that server.js exposes, answered from NotesStore, so the web UI
// in public/ runs unmodified. Requests arrive from the page's fetch() through the native bridge (see WebHost.swift).
import Foundation

struct APIRequest {
    var method: String
    var path: String                 // "/api/note"
    var query: [String: String]
    var headers: [String: String]    // lower-cased names
    var body: Data

    init(method: String, path: String, query: [String: String] = [:], headers: [String: String] = [:], body: Data = Data()) {
        self.method = method.uppercased(); self.path = path; self.query = query
        self.headers = Dictionary(headers.map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { a, _ in a }); self.body = body
    }
    /// "/api/note?name=a%2Fb" -> path + decoded query
    init(method: String, url: String, headers: [String: String] = [:], body: Data = Data()) {
        let c = URLComponents(string: "http://x" + url)
        self.init(method: method, path: c?.path ?? url, query: Dictionary((c?.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a }), headers: headers, body: body)
    }
}

struct APIResponse {
    var status: Int
    var headers: [String: String]
    var body: Data
    var json: Any? { try? JSONSerialization.jsonObject(with: body, options: [.fragmentsAllowed]) }
}

final class Router {
    let store: NotesStore
    init(store: NotesStore) { self.store = store }

    func handle(_ r: APIRequest) -> APIResponse {
        do { return try route(r) }
        catch let e as StoreError { return json(["error": e.message], e.status) }
        catch let e as CocoaError where e.code == .fileNoSuchFile || e.code == .fileReadNoSuchFile { return json(["error": "not found"], 404) }
        catch { return json(["error": error.localizedDescription], 400) }
    }

    private func json(_ obj: Any, _ status: Int = 200) -> APIResponse {
        let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.fragmentsAllowed])) ?? Data("{}".utf8)
        return APIResponse(status: status, headers: ["Content-Type": "application/json", "Cache-Control": "no-store"], body: data)
    }
    private func body(_ r: APIRequest) throws -> [String: Any] {
        guard let o = try JSONSerialization.jsonObject(with: r.body) as? [String: Any] else { throw StoreError.badName }
        return o
    }

    private func route(_ r: APIRequest) throws -> APIResponse {
        let m = r.method, p = r.path
        switch (m, p) {
        case ("GET", "/api/ping"): return json(["app": "plainnote"])
        case ("GET", "/api/notes"): return json(try store.listNotes())

        case ("PUT", "/api/note"):
            let base = r.headers["x-base-mtime"].flatMap(Double.init)
            let mtime = try store.writeNote(r.query["name"] ?? "", String(decoding: r.body, as: UTF8.self), base: base)
            return json(["ok": true, "mtime": mtime])
        case ("DELETE", "/api/note"):
            try store.deleteNote(r.query["name"] ?? ""); return json(["ok": true])
        case ("POST", "/api/append"):
            let b = try body(r)
            guard let text = b["text"] as? String else { return json(["error": "text required"], 400) }
            return json(["ok": true, "mtime": try store.append(b["name"] as? String ?? "", text)])

        case ("GET", "/api/trash"): return json(store.trashItems())
        case ("DELETE", "/api/trash"): store.emptyTrash(); return json(["ok": true])
        case ("POST", "/api/restore"):
            return json(["ok": true, "name": try store.restore(try body(r)["id"] as? String ?? "")])
        case ("POST", "/api/rename"):
            let b = try body(r); try store.rename(b["from"] as? String ?? "", b["to"] as? String ?? ""); return json(["ok": true])

        case ("GET", "/api/folders"): return json(store.listFolders())
        case ("POST", "/api/folder"): try store.makeFolder(try body(r)["name"] as? String ?? ""); return json(["ok": true])
        case ("DELETE", "/api/folder"): try store.removeFolder(r.query["name"] ?? ""); return json(["ok": true])

        case ("POST", "/api/upload"): return json(["path": try store.upload(r.query["name"] ?? "", r.body)])

        case ("GET", "/api/snippets"): return json(store.listSnippets())
        case ("GET", "/api/snippet"):
            let css = try store.snippet(r.query["name"] ?? "")
            return APIResponse(status: 200, headers: ["Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store"], body: Data(css.utf8))

        // Git sync needs a desktop; on iOS the notes folder syncs through the Files provider (iCloud Drive etc.).
        case ("GET", "/api/sync/status"): return json(["isRepo": false, "remote": "", "dirty": 0])
        case ("POST", "/api/sync/setup"), ("POST", "/api/sync"): return json(["error": "Git sync is not available on iOS. Keep the notes folder in iCloud Drive instead."], 400)

        default: return json(["error": "not found"], 404)
        }
    }
}
