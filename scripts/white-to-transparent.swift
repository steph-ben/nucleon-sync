// Turns the white background of a PNG into transparency (colour to alpha). Usage: white-to-transparent <in.png> <out.png>
import AppKit

let args = CommandLine.arguments
guard args.count == 3, let source = NSImage(contentsOfFile: args[1]), let cg = source.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    print("usage: white-to-transparent <in.png> <out.png>")
    exit(1)
}
let w = cg.width, h = cg.height
var pixels = [UInt8](repeating: 0, count: w * h * 4)
let space = CGColorSpaceCreateDeviceRGB()
let drew = pixels.withUnsafeMutableBytes { raw -> Bool in
    guard let ctx = CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    return true
}
guard drew else { print("cannot read \(args[1])"); exit(1) }
for i in 0..<(w * h) {
    let r = Double(pixels[i * 4]) / 255, g = Double(pixels[i * 4 + 1]) / 255, b = Double(pixels[i * 4 + 2]) / 255
    let alpha = max(1 - r, 1 - g, 1 - b)
    // Premultiplied: colour * alpha = channel - (1 - alpha).
    func channel(_ c: Double) -> UInt8 { UInt8(max(0, min(255, (c - (1 - alpha)) * 255 + 0.5))) }
    pixels[i * 4] = channel(r); pixels[i * 4 + 1] = channel(g); pixels[i * 4 + 2] = channel(b)
    pixels[i * 4 + 3] = UInt8(alpha * 255 + 0.5)
}
let out = pixels.withUnsafeMutableBytes { raw -> CGImage? in
    CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)?.makeImage()
}
guard let image = out, let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, "public.png" as CFString, 1, nil) else { print("cannot write \(args[2])"); exit(1) }
CGImageDestinationAddImage(dest, image, nil)
guard CGImageDestinationFinalize(dest) else { print("cannot write \(args[2])"); exit(1) }
