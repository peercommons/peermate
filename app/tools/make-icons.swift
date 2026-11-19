// Draws Peermate's app icons (two pawns linked phone to phone) with CoreGraphics.
//   swift tools/make-icons.swift [outDir]      (default: assets)
import AppKit
import CoreGraphics

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "assets"

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
  CGColor(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
          blue: CGFloat(hex & 0xff) / 255, alpha: a)
}
let greenTop = rgb(0x3A8460), greenBottom = rgb(0x1F4D36)
let cream = rgb(0xF6EFDF), amber = rgb(0xD9A25B), ink = rgb(0x173A29)

/// A pawn standing on (cx, baseY) in a y-up space, `h` tall.
func pawn(_ cx: CGFloat, _ baseY: CGFloat, _ h: CGFloat) -> [CGPath] {
  let s = h / 420
  var parts: [CGPath] = []
  func r(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ hh: CGFloat, _ rad: CGFloat) {
    let p = CGMutablePath(); defer { parts.append(p) }
    p.addRoundedRect(in: CGRect(x: cx + x * s - w * s / 2, y: baseY + y * s, width: w * s, height: hh * s),
                     cornerWidth: rad * s, cornerHeight: rad * s)
  }
  r(0, 0, 270, 46, 18)       // base
  r(0, 40, 226, 30, 12)      // plinth
  // body: flared, concave sides
  let b = CGMutablePath()
  let y0 = baseY + 66 * s, y1 = baseY + 262 * s
  b.move(to: CGPoint(x: cx - 108 * s, y: y0))
  b.addCurve(to: CGPoint(x: cx - 44 * s, y: y1), control1: CGPoint(x: cx - 52 * s, y: y0 + 60 * s),
             control2: CGPoint(x: cx - 44 * s, y: y1 - 90 * s))
  b.addLine(to: CGPoint(x: cx + 44 * s, y: y1))
  b.addCurve(to: CGPoint(x: cx + 108 * s, y: y0), control1: CGPoint(x: cx + 44 * s, y: y1 - 90 * s),
             control2: CGPoint(x: cx + 52 * s, y: y0 + 60 * s))
  b.closeSubpath()
  parts.append(b)
  r(0, 252, 150, 30, 15)     // collar
  parts.append(CGPath(ellipseIn: CGRect(x: cx - 72 * s, y: baseY + 268 * s, width: 144 * s, height: 144 * s), transform: nil)) // head
  return parts
}

/// Draws the emblem into a w×w context; `scale` shrinks it about the centre (adaptive-icon safe zone).
func emblem(_ c: CGContext, _ w: CGFloat, scale: CGFloat, mono: Bool) {
  c.saveGState()
  c.translateBy(x: w / 2, y: w / 2); c.scaleBy(x: scale * w / 1024, y: scale * w / 1024); c.translateBy(x: -512, y: -512)
  let h: CGFloat = 440, base: CGFloat = 214, lx: CGFloat = 326, rx: CGFloat = 698
  let headY = base + 340 * h / 420
  // the link: dots on an arc from head to head
  let p0 = CGPoint(x: lx + 18, y: headY + 110), p3 = CGPoint(x: rx - 18, y: headY + 110)
  let p1 = CGPoint(x: lx + 70, y: headY + 280), p2 = CGPoint(x: rx - 70, y: headY + 280)
  func bez(_ t: CGFloat) -> CGPoint {
    let u = 1 - t
    return CGPoint(x: u*u*u*p0.x + 3*u*u*t*p1.x + 3*u*t*t*p2.x + t*t*t*p3.x,
                   y: u*u*u*p0.y + 3*u*u*t*p1.y + 3*u*t*t*p2.y + t*t*t*p3.y)
  }
  c.setFillColor(mono ? rgb(0xffffff) : cream)
  let n = 7
  for i in 0..<n {
    let q = bez(CGFloat(i) / CGFloat(n - 1)), rad: CGFloat = 17
    c.fillEllipse(in: CGRect(x: q.x - rad, y: q.y - rad, width: 2 * rad, height: 2 * rad))
  }
  // soft shadow under the pieces
  if !mono { c.setShadow(offset: CGSize(width: 0, height: -14), blur: 28, color: rgb(0x000000, 0.35)) }
  c.setFillColor(mono ? rgb(0xffffff) : cream); c.beginTransparencyLayer(auxiliaryInfo: nil); for part in pawn(lx, base, h) { c.addPath(part); c.fillPath() }; c.endTransparencyLayer()
  c.setFillColor(mono ? rgb(0xffffff) : amber); c.beginTransparencyLayer(auxiliaryInfo: nil); for part in pawn(rx, base, h) { c.addPath(part); c.fillPath() }; c.endTransparencyLayer()
  c.restoreGState()
}

func background(_ c: CGContext, _ w: CGFloat) {
  let g = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [greenTop, greenBottom] as CFArray, locations: [0, 1])!
  c.drawLinearGradient(g, start: CGPoint(x: 0, y: w), end: CGPoint(x: 0, y: 0), options: [])
  // a faint board in the lower part
  let sq = w / 8
  for row in 0..<4 {
    c.setFillColor(rgb(0xffffff, 0.06 * (1 - CGFloat(row) / 4)))
    for col in 0..<8 where (row + col) % 2 == 0 { c.fill(CGRect(x: CGFloat(col) * sq, y: CGFloat(row) * sq, width: sq, height: sq)) }
  }
}

func png(_ name: String, _ size: Int, opaque: Bool, draw: (CGContext, CGFloat) -> Void) {
  let c = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: opaque ? CGImageAlphaInfo.noneSkipLast.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue)!
  draw(c, CGFloat(size))
  let rep = NSBitmapImageRep(cgImage: c.makeImage()!)
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(out)/\(name)"))
  print("\(out)/\(name) \(size)px")
}

png("icon.png", 1024, opaque: true) { c, w in background(c, w); emblem(c, w, scale: 1, mono: false) }
// Android adaptive icon: the system crops to a circle/squircle of ~66% of the layer.
png("android-icon-background.png", 512, opaque: true) { c, w in background(c, w) }
png("android-icon-foreground.png", 512, opaque: false) { c, w in emblem(c, w, scale: 0.66, mono: false) }
png("android-icon-monochrome.png", 432, opaque: false) { c, w in emblem(c, w, scale: 0.66, mono: true) }
png("splash-icon.png", 1024, opaque: false) { c, w in emblem(c, w, scale: 0.9, mono: false) }
png("favicon.png", 48, opaque: true) { c, w in background(c, w); emblem(c, w, scale: 1, mono: false) }
