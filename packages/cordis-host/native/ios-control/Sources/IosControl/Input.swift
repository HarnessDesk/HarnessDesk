import Foundation
struct InputFailure: Error, CustomStringConvertible {
    let code: String
    let description: String
    init(_ code: String, _ description: String) { self.code = code; self.description = description }
}
struct Point: Codable, Equatable { let x: Double; let y: Double }
enum Phase: UInt64 { case start = 0, position = 1, end = 2 }
struct Sample { let phase: Phase; let points: [Point]; let tMs: Int }
struct Geometry {
    let width: Double; let height: Double; let rotation: Int
    func normalize(_ point: Point) throws -> Point {
        guard width > 0, height > 0, point.x.isFinite, point.y.isFinite, point.x >= 0, point.y >= 0, point.x < width, point.y < height else { throw InputFailure("bounds", "Input coordinates must be inside the current screenshot.") }
        let x = point.x / width, y = point.y / height
        switch rotation {
        case 0: return Point(x: x, y: y)
        case 1: return Point(x: y, y: 1-x)
        case 2: return Point(x: 1-x, y: 1-y)
        case 3: return Point(x: 1-y, y: x)
        default: throw InputFailure("geometry", "The simulator display orientation is unavailable.")
        }
    }
}
func establish<T>(xcodeMajor: Int, connect: (String) throws -> T) throws -> T {
    // Legacy support requires its own verified toolchain. No substitution after a failed send.
    guard xcodeMajor >= 27 else { throw InputFailure("unsupported", "Native input requires a verified Xcode 27 DTUHID transport.") }
    return try connect("dtuhid")
}
func requireSymbols(_ names: [String], resolve: (String) -> Bool) throws {
    for name in names where !resolve(name) { throw InputFailure("symbol", "The installed Xcode is missing the simulator input symbol \(name).") }
}
enum Gesture {
    static func samples(from: [Point], to: [Point], durationMs: Int) throws -> [Sample] {
        guard from.count == to.count, (1...2).contains(from.count), (1...10000).contains(durationMs) else { throw InputFailure("gesture", "A gesture needs one or two contacts and a bounded duration.") }
        let steps = max(1, Int(ceil(Double(durationMs)/16)))
        var result = [Sample(phase: .start, points: from, tMs: 0)]
        for step in 1..<steps {
            let ratio = Double(step)/Double(steps)
            let points = zip(from, to).map { a,b in Point(x: a.x+(b.x-a.x)*ratio, y: a.y+(b.y-a.y)*ratio) }
            result.append(Sample(phase: .position, points: points, tMs: durationMs*step/steps))
        }
        result.append(Sample(phase: .end, points: to, tMs: durationMs))
        return result
    }
    static func deliver(_ samples: [Sample], sink: (Sample) throws -> Void, sleep: (Int) throws -> Void) throws {
        var held: Sample?, elapsed = 0
        do {
            for sample in samples {
                if sample.tMs > elapsed { try sleep(sample.tMs-elapsed) }
                try sink(sample)
                held = sample.phase == .end ? nil : sample
                elapsed = sample.tMs
            }
        } catch {
            if let held { try? sink(Sample(phase: .end, points: held.points, tMs: elapsed)) }
            throw error
        }
    }
}
func keyboardUsage(_ key: String) throws -> [UInt64] {
    switch key {
    case "return": return [40]
    case "delete": return [42]
    case "right": return [79]
    case "left": return [80]
    case "down": return [81]
    case "up": return [82]
    case "selectAll": return [227, 4]
    case "undo": return [227, 29]
    default: throw InputFailure("key", "Choose a supported simulator key.")
    }
}
func asciiUsages(_ text: String) throws -> [[UInt64]] {
    // US HID keyboard layout only; alternate layouts and Unicode are refused explicitly.
    try text.unicodeScalars.map { scalar in
        switch scalar.value {
        case 97...122: return [UInt64(scalar.value-97+4)]
        case 65...90: return [225, UInt64(scalar.value-65+4)]
        case 49...57: return [UInt64(scalar.value-49+30)]
        case 48: return [39]
        case 32: return [44]
        case 10: return [40]
        default: throw InputFailure("text", "This helper can enter US-layout letters, digits, spaces and newlines; this text needs an unverified insertion method.")
        }
    }
}
