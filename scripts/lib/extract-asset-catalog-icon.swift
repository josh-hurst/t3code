// Writes the 1024px image of a named icon from compiled asset catalogs as PNGs.
// Usage: xcrun swift extract-asset-catalog-icon.swift <name> <Assets.car> <out.png> [<Assets.car> <out.png> ...]
import AppKit

let arguments = CommandLine.arguments
guard arguments.count >= 4, (arguments.count - 2) % 2 == 0 else {
  FileHandle.standardError.write("usage: <name> <Assets.car> <out.png> [...]\n".data(using: .utf8)!)
  exit(2)
}
let name = arguments[1]
let fileManager = FileManager.default

for pair in stride(from: 2, to: arguments.count, by: 2) {
  let catalogPath = arguments[pair]
  let outputPath = arguments[pair + 1]
  // NSBundle only reads asset catalogs from a bundle's Resources directory.
  let bundlePath = NSTemporaryDirectory() + "t3-icon-\(getpid())-\(pair).bundle"
  try? fileManager.removeItem(atPath: bundlePath)
  defer { try? fileManager.removeItem(atPath: bundlePath) }
  do {
    try fileManager.createDirectory(atPath: bundlePath + "/Contents/Resources", withIntermediateDirectories: true)
    try fileManager.copyItem(atPath: catalogPath, toPath: bundlePath + "/Contents/Resources/Assets.car")
    try "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>t3.icon-export.\(getpid()).\(pair)</string></dict></plist>"
      .write(toFile: bundlePath + "/Contents/Info.plist", atomically: true, encoding: .utf8)
  } catch {
    FileHandle.standardError.write("could not stage \(catalogPath): \(error)\n".data(using: .utf8)!)
    exit(1)
  }
  guard let image = Bundle(path: bundlePath)?.image(forResource: name) else {
    FileHandle.standardError.write("no image named \(name) in \(catalogPath)\n".data(using: .utf8)!)
    exit(1)
  }
  let representation = image.representations.first { $0.pixelsWide == 1024 && $0.pixelsHigh == 1024 }
  var rect = NSRect(x: 0, y: 0, width: 1024, height: 1024)
  guard
    let cgImage = representation?.cgImage(forProposedRect: &rect, context: nil, hints: nil),
    let png = NSBitmapImageRep(cgImage: cgImage).representation(using: .png, properties: [:])
  else {
    FileHandle.standardError.write("no 1024px rendition of \(name) in \(catalogPath)\n".data(using: .utf8)!)
    exit(1)
  }
  do {
    try png.write(to: URL(fileURLWithPath: outputPath))
  } catch {
    FileHandle.standardError.write("could not write \(outputPath): \(error)\n".data(using: .utf8)!)
    exit(1)
  }
}
