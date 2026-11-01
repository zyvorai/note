// Generates Plainnote.icns: swiftc icon.swift -o icon && ./icon out.iconset
import Cocoa

func render(_ px: Int) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(px)
    let bg = NSBezierPath(roundedRect: NSRect(x: s * 0.06, y: s * 0.06, width: s * 0.88, height: s * 0.88), xRadius: s * 0.2, yRadius: s * 0.2)
    NSGradient(starting: NSColor(red: 0.45, green: 0.45, blue: 0.95, alpha: 1), ending: NSColor(red: 0.30, green: 0.30, blue: 0.78, alpha: 1))!.draw(in: bg, angle: -90)
    // page
    let page = NSBezierPath(roundedRect: NSRect(x: s * 0.27, y: s * 0.20, width: s * 0.46, height: s * 0.60), xRadius: s * 0.04, yRadius: s * 0.04)
    NSColor.white.setFill(); page.fill()
    // text lines
    NSColor(red: 0.45, green: 0.45, blue: 0.85, alpha: 1).setFill()
    for (i, w) in [0.30, 0.30, 0.20].enumerated() {
        NSBezierPath(roundedRect: NSRect(x: s * 0.33, y: s * (0.66 - 0.09 * CGFloat(i)), width: s * CGFloat(w), height: s * 0.035), xRadius: s * 0.017, yRadius: s * 0.017).fill()
    }
    // link node
    NSColor(red: 0.30, green: 0.30, blue: 0.78, alpha: 1).setFill()
    NSBezierPath(ovalIn: NSRect(x: s * 0.36, y: s * 0.27, width: s * 0.09, height: s * 0.09)).fill()
    NSBezierPath(ovalIn: NSRect(x: s * 0.55, y: s * 0.27, width: s * 0.09, height: s * 0.09)).fill()
    let line = NSBezierPath(); line.lineWidth = s * 0.02
    line.move(to: NSPoint(x: s * 0.405, y: s * 0.315)); line.line(to: NSPoint(x: s * 0.595, y: s * 0.315))
    NSColor(red: 0.30, green: 0.30, blue: 0.78, alpha: 1).setStroke(); line.stroke()
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let dir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Plainnote.iconset"
try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
    try! render(base).write(to: URL(fileURLWithPath: "\(dir)/icon_\(base)x\(base).png"))
    try! render(base * 2).write(to: URL(fileURLWithPath: "\(dir)/icon_\(base)x\(base)@2x.png"))
}
