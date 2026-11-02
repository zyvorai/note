// A launch-time smoke test driven from the command line (see ios/build.sh): when PLAINNOTE_SELFTEST is set the app
// exercises the real web UI against the real native bridge and writes the outcome to <notes>/.selftest-<n>.json.
import Foundation

enum SelfTest {
    static var mode: String? { ProcessInfo.processInfo.environment["PLAINNOTE_SELFTEST"] }

    static func runIfRequested(on host: WebHost) {
        guard let mode else { return }
        let script = """
        (async () => {
          const out = { mode: '\(mode)', ok: false, steps: [] };
          const step = (n, v) => out.steps.push([n, v]);
          try {
            await plainnote.ready;
            step('html classes', document.documentElement.className);
            if ('\(mode)' === '1') {
              await open('Self Test', true);
              const ed = document.querySelector('#ed'); ed.value = '# Hello **iOS**\\n- [ ] task\\n'; ed.dispatchEvent(new Event('input'));
              await flush();
              localStorage.setItem('selftest', 'persisted');
              const list = await (await fetch('/api/notes')).json();
              step('listed', list.map((n) => n.name));
              step('text', list.find((n) => n.name === 'Self Test')?.text);
              const sel = await (await fetch('/api/note?name=Self%20Test', { method: 'PUT', body: 'x', headers: { 'x-base-mtime': '1' } })).status;
              step('stale save status', sel);
              await fetch('/api/folder', { method: 'POST', body: JSON.stringify({ name: 'Projects' }) });
              await load(); step('folders', folders);
              await open('Projects/Inner', true); await flush();
              out.ok = list.some((n) => n.name === 'Self Test') && sel === 409;
            } else {
              step('localStorage', localStorage.getItem('selftest'));
              step('cur', cur);
              step('tabs', tabs.map((t) => t.name));
              step('notes', [...notes.keys()].sort());
              out.ok = localStorage.getItem('selftest') === 'persisted' && notes.has('Self Test') && notes.has('Projects/Inner');
            }
          } catch (e) { step('error', String(e && e.stack || e)); }
          window.webkit.messageHandlers.mac.postMessage({ t: 'selftest', result: JSON.stringify(out) });
        })()
        """
        host.js(script)
    }

    static func record(_ result: String, in root: URL) {
        let n = mode ?? "0"
        try? result.write(to: root.appendingPathComponent(".selftest-\(n).json"), atomically: true, encoding: .utf8)
    }
}
