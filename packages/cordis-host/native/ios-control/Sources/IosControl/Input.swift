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
func establish<T>(xcodeVersion: [String: Any], connect: (String) throws -> T) throws -> T {
    let major = (xcodeVersion["CFBundleShortVersionString"] as? String)?.split(separator: ".").first.flatMap { Int($0) } ?? 0
    guard major >= 27 else { throw InputFailure("xcode", "Native input requires a verified Xcode 27 DTUHID transport.") }
    return try connect("dtuhid")
}
func withInputConnection<T>(action: [String: Any]?, connect: () throws -> T, reset: (T) throws -> Void) throws -> T {
    switch action?["kind"] as? String {
    case "keyboard": throw InputFailure("keyboard", "Software keyboard show and hide are unavailable because simulator-local visibility observation has not been verified.")
    case "rotateDevice": throw InputFailure("orientation", "Device rotation is unavailable because its idempotent native delivery has not been verified on this Xcode.")
    case "button" where action?["button"] as? String == "lock": throw InputFailure("lock", "Deterministic device locking is unavailable because native locked-state delivery could not be verified on this Xcode.")
    default: break
    }
    let connection = try connect()
    try reset(connection)
    return connection
}
struct InputTransport {
    let cancelled: () -> Bool
    let send: ([String: Any], String, Bool) throws -> Void
    func event(_ payload: [String: Any], _ type: String) throws { try send(payload, type, !cancelled()) }
    func contact(_ sample: Sample) throws {
        if sample.phase != .end && cancelled() { throw CancellationError() }
        var payload: [String: Any] = ["eventType": sample.phase.rawValue, "edge": UInt64(0), "target": UInt64(0), "pointOne": ["x": sample.points[0].x, "y": sample.points[0].y]]
        if sample.points.count == 2 { payload["pointTwo"] = ["x": sample.points[1].x, "y": sample.points[1].y] }
        try event(payload, "IndigoDigitizerEvent")
    }
    func keys(_ usages: [UInt64]) throws {
        var held: [UInt64] = []
        defer { for usage in held.reversed() { try? event(["usageCode": usage, "state": UInt64(2)], "IndigoKeyboardButtonEvent") } }
        for usage in usages {
            if cancelled() { throw CancellationError() }
            held.append(usage)
            try event(["usageCode": usage, "state": UInt64(1)], "IndigoKeyboardButtonEvent")
        }
        for usage in held.reversed() { try event(["usageCode": usage, "state": UInt64(2)], "IndigoKeyboardButtonEvent") }
        held = []
    }
    func button(_ usage: UInt64, duration: Int, sleep: (Int) throws -> Void) throws {
        if cancelled() { throw CancellationError() }
        defer { try? event(["usagePage": UInt64(12), "usageCode": usage, "state": UInt64(2)], "IndigoButtonEvent") }
        try event(["usagePage": UInt64(12), "usageCode": usage, "state": UInt64(1)], "IndigoButtonEvent")
        try sleep(duration)
    }
    func releaseContacts() throws {
        let point = ["x": 0.0, "y": 0.0]
        try send(["eventType": UInt64(2), "edge": UInt64(0), "target": UInt64(0), "pointOne": point, "pointTwo": point], "IndigoDigitizerEvent", false)
    }
}
enum Gesture {
    static func samples(from: [Point], to: [Point], durationMs: Int) throws -> [Sample] {
        guard from.count == to.count, (1...2).contains(from.count), (1...10000).contains(durationMs) else { throw InputFailure("gesture", "A gesture needs one or two contacts and a bounded duration.") }
        if from == to { return [Sample(phase: .start, points: from, tMs: 0), Sample(phase: .end, points: to, tMs: durationMs)] }
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
                // A send may reach the guest before its acknowledgement fails.
                if sample.phase != .end { held = sample }
                try sink(sample)
                if sample.phase == .end { held = nil }
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
extension Gesture {
    static func drag(_ path: [Sample]) throws -> [Sample] {
        guard (2...600).contains(path.count), path.first?.tMs == 0 else { throw InputFailure("path", "A drag needs 2 to 600 points and must start at zero milliseconds.") }
        var previous = -1
        for sample in path {
            guard sample.points.count == 1, sample.tMs > previous, sample.tMs <= 10000 else { throw InputFailure("path", "Drag sample times must strictly increase through 10000 milliseconds.") }
            previous = sample.tMs
        }
        return path.enumerated().map { i,s in Sample(phase:i == 0 ? .start : i == path.count-1 ? .end : .position,points:s.points,tMs:s.tMs) }
    }
    static func rotation(center: Point, radius: Double, degrees: Double, durationMs: Int) throws -> [Sample] {
        guard radius.isFinite, radius > 0, degrees.isFinite, abs(degrees) <= 360, (1...10000).contains(durationMs) else { throw InputFailure("rotation", "A rotation needs a positive radius, a bounded angle and duration.") }
        let steps=max(1,Int(ceil(Double(durationMs)/16)))
        return (0...steps).map { step in
            let angle=degrees * .pi / 180 * Double(step)/Double(steps)
            let dx=cos(angle)*radius, dy=sin(angle)*radius
            return Sample(phase:step == 0 ? .start : step == steps ? .end : .position, points:[Point(x:center.x+dx,y:center.y+dy),Point(x:center.x-dx,y:center.y-dy)],tMs:durationMs*step/steps)
        }
    }
}
