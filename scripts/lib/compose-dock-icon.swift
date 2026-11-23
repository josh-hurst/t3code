// Places full-bleed macOS icon renders on the standard 1024px Dock canvas: an 824px body inset
// 100px with a soft shadow, because the Dock draws an icon set at runtime exactly as given.
// Usage: xcrun swift compose-dock-icon.swift <full-bleed.png> <out.png> [<full-bleed.png> <out.png> ...]
import AppKit

let arguments = CommandLine.arguments
guard arguments.count >= 3, (arguments.count - 1) % 2 == 0 else {
  FileHandle.standardError.write("usage: <full-bleed.png> <out.png> [...]\n".data(using: .utf8)!)
  exit(2)
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("\(message)\n".data(using: .utf8)!)
  exit(1)
}

for pair in stride(from: 1, to: arguments.count, by: 2) {
  let inputPath = arguments[pair]
  let outputPath = arguments[pair + 1]
  var rect = NSRect(x: 0, y: 0, width: 1024, height: 1024)
  guard
    let image = NSImage(contentsOfFile: inputPath)?.cgImage(forProposedRect: &rect, context: nil, hints: nil),
    let colorSpace = CGColorSpace(name: CGColorSpace.displayP3),
    let context = CGContext(
      data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { fail("could not read \(inputPath)") }
  context.interpolationQuality = .high
  context.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: CGColor(gray: 0, alpha: 0.32))
  context.draw(image, in: CGRect(x: 100, y: 100, width: 824, height: 824))
  guard
    let composed = context.makeImage(),
    let png = NSBitmapImageRep(cgImage: composed).representation(using: .png, properties: [:])
  else { fail("could not compose \(inputPath)") }
  do {
    try png.write(to: URL(fileURLWithPath: outputPath))
  } catch {
    fail("could not write \(outputPath): \(error)")
  }
}
