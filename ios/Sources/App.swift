import SwiftUI

@main
struct PlainnoteApp: App {
    @StateObject private var host = WebHost()

    var body: some Scene {
        WindowGroup {
            WebView(host: host)
                .ignoresSafeArea()
                .background(Color(UIColor.systemBackground))
                .onAppear { host.start() }
                .onOpenURL { host.handle($0) }
        }
    }
}

struct WebView: UIViewRepresentable {
    let host: WebHost
    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .clear
        host.start()
        host.web.frame = container.bounds
        host.web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(host.web)
        return container
    }
    func updateUIView(_ uiView: UIView, context: Context) {}
}
