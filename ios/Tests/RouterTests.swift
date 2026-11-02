// Mirrors tests/server.test.js: the Swift routes must behave like the Node server the web UI was written against.
import XCTest

final class RouterTests: XCTestCase {
    var dir: URL!
    var router: Router!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("plainnote-ios-\(UUID().uuidString)")
        router = Router(store: NotesStore(root: dir))
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    @discardableResult func call(_ method: String, _ url: String, _ body: String = "", headers: [String: String] = [:]) -> APIResponse {
        router.handle(APIRequest(method: method, url: url, headers: headers, body: Data(body.utf8)))
    }
    func put(_ name: String, _ text: String, headers: [String: String] = [:]) -> APIResponse {
        call("PUT", "/api/note?name=" + NotesStore.encodeURIComponent(name), text, headers: headers)
    }
    func names() -> [String] { ((call("GET", "/api/notes").json as? [[String: Any]]) ?? []).compactMap { $0["name"] as? String }.sorted() }

    func testCrudSubfoldersAndListing() throws {
        XCTAssertEqual(put("one", "hello").status, 200)
        XCTAssertEqual(put("a/b/deep", "x").status, 200)
        XCTAssertEqual(names(), ["a/b/deep", "one"])
        let list = call("GET", "/api/notes").json as! [[String: Any]]
        XCTAssertEqual(list.first { $0["name"] as? String == "one" }?["text"] as? String, "hello")
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent("a/b/deep.md").path))
    }

    func testRejectsPathTraversal() throws {
        for bad in ["../outside", "a/../../outside", "/../x"] {
            XCTAssertGreaterThanOrEqual(put(bad, "x").status, 400, bad)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.deletingLastPathComponent().appendingPathComponent("outside.md").path))
        XCTAssertEqual(call("PUT", "/api/note", "x").status, 400, "missing name")
    }

    func testOptimisticConcurrencyReturns409() throws {
        let first = put("n", "v1").json as! [String: Any]
        let m = first["mtime"] as! Double
        XCTAssertEqual(put("n", "v2", headers: ["x-base-mtime": String(m)]).status, 200, "up to date")
        // someone else changes the file underneath
        try "other".write(to: dir.appendingPathComponent("n.md"), atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: 60)], ofItemAtPath: dir.appendingPathComponent("n.md").path)
        let r = put("n", "mine", headers: ["x-base-mtime": String(m)])
        XCTAssertEqual(r.status, 409)
        XCTAssertEqual((r.json as? [String: Any])?["error"] as? String, "conflict")
        XCTAssertEqual(put("n", "forced").status, 200, "no base header means no check")
    }

    func testRenameMovesAndRefusesToOverwrite() throws {
        put("a", "A"); put("b", "B")
        XCTAssertEqual(call("POST", "/api/rename", #"{"from":"a","to":"sub/c"}"#).status, 200)
        XCTAssertEqual(names(), ["b", "sub/c"])
        XCTAssertEqual(call("POST", "/api/rename", #"{"from":"b","to":"sub/c"}"#).status, 409)
        XCTAssertEqual(call("POST", "/api/rename", #"{"from":"nope","to":"z"}"#).status, 404)
    }

    func testDeleteGoesToTrashAndRestoreHandlesNameClash() throws {
        put("gone", "bye"); put("f/x y", "inner")
        XCTAssertEqual(call("DELETE", "/api/note?name=gone").status, 200)
        XCTAssertEqual(names(), ["f/x y"])
        var trash = call("GET", "/api/trash").json as! [[String: Any]]
        XCTAssertEqual(trash.count, 1)
        XCTAssertEqual(trash[0]["name"] as? String, "gone")
        put("gone", "new one")
        let id = trash[0]["id"] as! String
        let r = call("POST", "/api/restore", #"{"id":"\#(id)"}"#)
        XCTAssertEqual((r.json as? [String: Any])?["name"] as? String, "gone (restored)", "never overwrites")
        XCTAssertEqual(call("POST", "/api/restore", #"{"id":"../x.md"}"#).status, 400)
        call("DELETE", "/api/note?name=" + NotesStore.encodeURIComponent("f/x y"))
        trash = call("GET", "/api/trash").json as! [[String: Any]]
        XCTAssertEqual(trash.first?["name"] as? String, "f/x y", "names survive the trip through the file name")
        XCTAssertEqual(call("DELETE", "/api/trash").status, 200)
        XCTAssertEqual((call("GET", "/api/trash").json as! [Any]).count, 0)
        XCTAssertEqual(call("DELETE", "/api/note?name=missing").status, 404)
    }

    func testAppendCreatesOrExtendsAndStaysInside() throws {
        XCTAssertEqual(call("POST", "/api/append", #"{"name":"daily/today","text":"one\n\n"}"#).status, 200)
        call("POST", "/api/append", #"{"name":"daily/today","text":"two"}"#)
        let list = call("GET", "/api/notes").json as! [[String: Any]]
        XCTAssertEqual(list.first?["text"] as? String, "one\ntwo\n")
        XCTAssertGreaterThanOrEqual(call("POST", "/api/append", #"{"name":"../evil","text":"x"}"#).status, 400)
        XCTAssertEqual(call("POST", "/api/append", #"{"name":"n"}"#).status, 400, "text required")
    }

    func testFoldersCreateListDeleteOnlyWhenEmptyAndStayInside() throws {
        XCTAssertEqual(call("POST", "/api/folder", #"{"name":"projects/2026"}"#).status, 200)
        XCTAssertEqual(call("POST", "/api/folder", #"{"name":"empty"}"#).status, 200)
        put("projects/plan", "x")
        XCTAssertEqual(call("GET", "/api/folders").json as? [String], ["empty", "projects", "projects/2026"])
        for bad in ["../outside", ".hidden", "a/../../b", "", "a/.git"] {
            XCTAssertGreaterThanOrEqual(call("POST", "/api/folder", #"{"name":"\#(bad)"}"#).status, 400, bad)
        }
        XCTAssertEqual(call("DELETE", "/api/folder?name=projects").status, 409, "non-empty is kept")
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent("projects/plan.md").path))
        XCTAssertEqual(call("DELETE", "/api/folder?name=empty").status, 200)
        XCTAssertGreaterThanOrEqual(call("DELETE", "/api/folder?name=..").status, 400)
    }

    func testImageUploadAndSafeServing() throws {
        let png = Data([0x89, 0x50, 0x4E, 0x47, 1, 2, 3])
        let r = router.handle(APIRequest(method: "POST", url: "/api/upload?name=My%20Pic!.PNG", body: png))
        XCTAssertEqual(r.status, 200)
        let path = (r.json as! [String: Any])["path"] as! String
        XCTAssertTrue(path.hasPrefix("attachments/") && path.hasSuffix("-My-Pic-.png"), path)
        let (data, type) = try router.store.file(path)
        XCTAssertEqual(data, png); XCTAssertEqual(type, "image/png")
        XCTAssertEqual(router.handle(APIRequest(method: "POST", url: "/api/upload?name=evil.html", body: png)).status, 400)
        try "secret".write(to: dir.appendingPathComponent("note.md"), atomically: true, encoding: .utf8)
        XCTAssertThrowsError(try router.store.file("note.md"), "only images are served")
        XCTAssertThrowsError(try router.store.file("../outside.png"))
    }

    func testSnippetsListedAndServedFromTheSnippetsFolderOnly() throws {
        XCTAssertEqual((call("GET", "/api/snippets").json as! [Any]).count, 0)
        let s = dir.appendingPathComponent(".plainnote/snippets")
        try FileManager.default.createDirectory(at: s, withIntermediateDirectories: true)
        try "body{--x:1}".write(to: s.appendingPathComponent("dark tweaks.css"), atomically: true, encoding: .utf8)
        try "no".write(to: s.appendingPathComponent("readme.txt"), atomically: true, encoding: .utf8)
        try "outside".write(to: dir.appendingPathComponent("secret.css"), atomically: true, encoding: .utf8)
        XCTAssertEqual((call("GET", "/api/snippets").json as! [[String: String]]), [["name": "dark tweaks.css"]])
        let r = call("GET", "/api/snippet?name=dark%20tweaks.css")
        XCTAssertEqual(r.status, 200); XCTAssertEqual(r.headers["Content-Type"], "text/css; charset=utf-8")
        XCTAssertEqual(String(decoding: r.body, as: UTF8.self), "body{--x:1}")
        for bad in ["../secret.css", "sub/x.css", "readme.txt", "", ".hidden.css"] {
            let x = call("GET", "/api/snippet?name=" + NotesStore.encodeURIComponent(bad))
            XCTAssertGreaterThanOrEqual(x.status, 400, bad)
            XCTAssertNotEqual(String(decoding: x.body, as: UTF8.self), "outside")
        }
    }

    func testHiddenFoldersAndNonMarkdownFilesAreNotListed() throws {
        put("visible", "v")
        try FileManager.default.createDirectory(at: dir.appendingPathComponent(".git"), withIntermediateDirectories: true)
        try "x".write(to: dir.appendingPathComponent(".git/hidden.md"), atomically: true, encoding: .utf8)
        try "x".write(to: dir.appendingPathComponent("readme.txt"), atomically: true, encoding: .utf8)
        XCTAssertEqual(names(), ["visible"])
    }

    func testSyncIsUnavailableButAnswersPolitely() throws {
        XCTAssertEqual((call("GET", "/api/sync/status").json as? [String: Any])?["isRepo"] as? Bool, false)
        XCTAssertEqual(call("POST", "/api/sync").status, 400)
        XCTAssertEqual(call("GET", "/api/nope").status, 404)
        XCTAssertEqual((call("GET", "/api/ping").json as? [String: Any])?["app"] as? String, "plainnote")
    }
}
