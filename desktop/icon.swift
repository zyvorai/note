// Generates Plainnote.icns: swiftc icon.swift -o icon && ./icon out.iconset   (optionally: ./icon out.iconset preview.png)
import Cocoa

func c(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) -> NSColor { NSColor(calibratedRed: r, green: g, blue: b, alpha: a) }

func draw(_ s: CGFloat) {
    func R(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> NSRect { NSRect(x: s * x, y: s * y, width: s * w, height: s * h) }
    func P(_ x: Double, _ y: Double) -> NSPoint { NSPoint(x: s * x, y: s * y) }

    // squircle tile with a diagonal indigo -> violet -> magenta gradient
    let tile = NSBezierPath(roundedRect: R(0.06, 0.06, 0.88, 0.88), xRadius: s * 0.2, yRadius: s * 0.2)
    NSGraphicsContext.saveGraphicsState()
    let tileShadow = NSShadow(); tileShadow.shadowColor = c(0.15, 0.08, 0.45, 0.25); tileShadow.shadowBlurRadius = s * 0.025; tileShadow.shadowOffset = NSSize(width: 0, height: -s * 0.015)
    tileShadow.set(); c(0.4, 0.3, 0.9).setFill(); tile.fill()
    NSGraphicsContext.restoreGraphicsState()
    NSGraphicsContext.saveGraphicsState()
    tile.addClip()
    NSGradient(colors: [c(0.30, 0.36, 0.98), c(0.52, 0.30, 0.95), c(0.82, 0.31, 0.78)], atLocations: [0, 0.5, 1], colorSpace: .deviceRGB)!.draw(in: tile.bounds, angle: -50)
    // soft glow top-left, gloss on the upper half
    NSGradient(colors: [c(1, 1, 1, 0.26), c(1, 1, 1, 0)], atLocations: [0, 1], colorSpace: .deviceRGB)!.draw(in: R(0.06, 0.5, 0.88, 0.44), angle: -90)

    // page with a folded corner and a soft shadow
    let fold = 0.12, px = 0.22, py = 0.17, pw = 0.46, ph = 0.64
    let page = NSBezierPath()
    page.move(to: P(px + 0.05, py)); page.line(to: P(px + pw - 0.05, py))
    page.curve(to: P(px + pw, py + 0.05), controlPoint1: P(px + pw - 0.02, py), controlPoint2: P(px + pw, py + 0.02))
    page.line(to: P(px + pw, py + ph - fold)); page.line(to: P(px + pw - fold, py + ph))
    page.line(to: P(px + 0.05, py + ph))
    page.curve(to: P(px, py + ph - 0.05), controlPoint1: P(px + 0.02, py + ph), controlPoint2: P(px, py + ph - 0.02))
    page.line(to: P(px, py + 0.05))
    page.curve(to: P(px + 0.05, py), controlPoint1: P(px, py + 0.02), controlPoint2: P(px + 0.02, py))
    page.close()
    NSGraphicsContext.saveGraphicsState()
    let ps = NSShadow(); ps.shadowColor = c(0.1, 0.05, 0.35, 0.40); ps.shadowBlurRadius = s * 0.035; ps.shadowOffset = NSSize(width: 0, height: -s * 0.02)
    ps.set(); c(1, 1, 1).setFill(); page.fill()
    NSGraphicsContext.restoreGraphicsState()
    NSGradient(colors: [c(1, 1, 1), c(0.93, 0.92, 1)], atLocations: [0, 1], colorSpace: .deviceRGB)!.draw(in: page, angle: -90)
    // the fold
    let f = NSBezierPath(); f.move(to: P(px + pw - fold, py + ph)); f.line(to: P(px + pw - fold, py + ph - fold)); f.line(to: P(px + pw, py + ph - fold)); f.close()
    NSGradient(colors: [c(0.80, 0.78, 1), c(0.66, 0.62, 0.98)], atLocations: [0, 1], colorSpace: .deviceRGB)!.draw(in: f, angle: -45)

    // heading + text lines
    let hd = NSBezierPath(roundedRect: R(0.28, 0.62, 0.20, 0.05), xRadius: s * 0.025, yRadius: s * 0.025)
    NSGradient(colors: [c(0.36, 0.34, 0.96), c(0.62, 0.32, 0.90)], atLocations: [0, 1], colorSpace: .deviceRGB)!.draw(in: hd, angle: 0)
    c(0.80, 0.79, 0.93).setFill()
    for (i, w) in [0.34, 0.30, 0.22].enumerated() {
        NSBezierPath(roundedRect: R(0.28, 0.53 - 0.075 * Double(i), w, 0.028), xRadius: s * 0.014, yRadius: s * 0.014).fill()
    }

    // linked-notes graph, overlapping the page corner
    let a = P(0.55, 0.255), b = P(0.78, 0.40), d = P(0.72, 0.16)
    let edge = NSBezierPath(); edge.lineWidth = s * 0.022; edge.lineCapStyle = .round
    edge.move(to: a); edge.line(to: b); edge.move(to: a); edge.line(to: d); edge.move(to: b); edge.line(to: d)
    c(1, 1, 1, 0.95).setStroke(); NSGraphicsContext.saveGraphicsState()
    let es = NSShadow(); es.shadowColor = c(0.1, 0.05, 0.4, 0.5); es.shadowBlurRadius = s * 0.012; es.shadowOffset = NSSize(width: 0, height: -s * 0.006); es.set()
    edge.stroke(); NSGraphicsContext.restoreGraphicsState()
    func node(_ p: NSPoint, _ r: CGFloat, _ top: NSColor, _ bottom: NSColor) {
        let o = NSBezierPath(ovalIn: NSRect(x: p.x - s * r, y: p.y - s * r, width: s * r * 2, height: s * r * 2))
        NSGraphicsContext.saveGraphicsState()
        let ns = NSShadow(); ns.shadowColor = c(0.1, 0.05, 0.4, 0.55); ns.shadowBlurRadius = s * 0.016; ns.shadowOffset = NSSize(width: 0, height: -s * 0.008); ns.set()
        c(1, 1, 1).setFill(); o.fill(); NSGraphicsContext.restoreGraphicsState()
        let inner = NSBezierPath(ovalIn: NSRect(x: p.x - s * r * 0.78, y: p.y - s * r * 0.78, width: s * r * 1.56, height: s * r * 1.56))
        NSGradient(colors: [top, bottom], atLocations: [0, 1], colorSpace: .deviceRGB)!.draw(in: inner, angle: -90)
    }
    node(a, 0.062, c(1.0, 0.86, 0.38), c(1.0, 0.62, 0.20))
    node(b, 0.048, c(0.46, 0.95, 0.86), c(0.16, 0.74, 0.74))
    node(d, 0.044, c(1.0, 0.62, 0.78), c(0.92, 0.32, 0.55))
    NSGraphicsContext.restoreGraphicsState()
    // fine inner rim for definition
    c(1, 1, 1, 0.22).setStroke(); tile.lineWidth = max(1, s * 0.004); tile.stroke()
}

func render(_ px: Int) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    draw(CGFloat(px))
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let dir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Plainnote.iconset"
try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
    try! render(base).write(to: URL(fileURLWithPath: "\(dir)/icon_\(base)x\(base).png"))
    try! render(base * 2).write(to: URL(fileURLWithPath: "\(dir)/icon_\(base)x\(base)@2x.png"))
}
if CommandLine.arguments.count > 2 { try! render(1024).write(to: URL(fileURLWithPath: CommandLine.arguments[2])) }
