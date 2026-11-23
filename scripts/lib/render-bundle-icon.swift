// Renders app bundles' icons at 1024px with the system's own icon renderer, so the result has
// the same glass lighting, shape and shadow macOS draws for every other app in the Dock.
// IconServices is private; this is a maintainer-only export step, not shipped code.
// Usage: xcrun swift render-bundle-icon.swift <light|dark> <App.app> <out.png> [<light|dark> <App.app> <out.png> ...]
import AppKit
import ObjectiveC

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("\(message)\n".data(using: .utf8)!)
  exit(1)
}

let arguments = CommandLine.arguments
guard arguments.count >= 4, (arguments.count - 1) % 3 == 0 else {
  fail("usage: <light|dark> <App.app> <out.png> [...]")
}
guard dlopen("/System/Library/PrivateFrameworks/IconServices.framework/IconServices", RTLD_NOW) != nil,
  let iconClass = NSClassFromString("ISBundleIcon") as? NSObject.Type,
  let descriptorClass = NSClassFromString("ISImageDescriptor") as? NSObject.Type
else { fail("IconServices is unavailable") }

func method<T>(_ object: AnyObject, _ name: String, as _: T.Type) -> T {
  guard let implementation = class_getMethodImplementation(object_getClass(object), NSSelectorFromString(name)) else {
    fail("IconServices has no \(name)")
  }
  return unsafeBitCast(implementation, to: T.self)
}

typealias InitWithURL = @convention(c) (AnyObject, Selector, NSURL) -> AnyObject
typealias InitWithSize = @convention(c) (AnyObject, Selector, CGSize, CGFloat) -> AnyObject
typealias SetUnsigned = @convention(c) (AnyObject, Selector, UInt) -> Void
typealias ObjectForObject = @convention(c) (AnyObject, Selector, AnyObject) -> AnyObject?
typealias ImageForObject = @convention(c) (AnyObject, Selector, AnyObject) -> Unmanaged<CGImage>?

for index in stride(from: 1, to: arguments.count, by: 3) {
  let appearance = arguments[index]
  let bundlePath = arguments[index + 1]
  let outputPath = arguments[index + 2]
  guard appearance == "light" || appearance == "dark" else { fail("unknown appearance \(appearance)") }

  let iconAllocation = iconClass.perform(NSSelectorFromString("alloc")).takeUnretainedValue()
  let icon = method(iconAllocation, "initWithBundleURL:", as: InitWithURL.self)(
    iconAllocation, NSSelectorFromString("initWithBundleURL:"), NSURL(fileURLWithPath: bundlePath))
  let descriptorAllocation = descriptorClass.perform(NSSelectorFromString("alloc")).takeUnretainedValue()
  let descriptor = method(descriptorAllocation, "initWithSize:scale:", as: InitWithSize.self)(
    descriptorAllocation, NSSelectorFromString("initWithSize:scale:"), CGSize(width: 512, height: 512), 2)
  method(descriptor, "setAppearance:", as: SetUnsigned.self)(
    descriptor, NSSelectorFromString("setAppearance:"), appearance == "dark" ? 1 : 0)
  // Without preparing first, the renderer returns a placeholder while it draws in the background.
  _ = method(icon, "prepareImageForDescriptor:", as: ObjectForObject.self)(
    icon, NSSelectorFromString("prepareImageForDescriptor:"), descriptor)
  guard
    let image = method(icon, "CGImageForImageDescriptor:", as: ImageForObject.self)(
      icon, NSSelectorFromString("CGImageForImageDescriptor:"), descriptor)?.takeUnretainedValue(),
    let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
  else { fail("could not render the icon of \(bundlePath)") }
  do {
    try png.write(to: URL(fileURLWithPath: outputPath))
  } catch {
    fail("could not write \(outputPath): \(error)")
  }
}
