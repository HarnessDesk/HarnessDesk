import Foundation
import SimulatorBridge
if CommandLine.arguments.contains("--version") { print("{\"protocolVersion\":1,\"name\":\"hd-ios-control\"}"); exit(0) }
if CommandLine.arguments.contains("--pointer") {
    let data = try JSONSerialization.data(withJSONObject: HDSimulatorConnection.pointerPosition(), options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!); exit(0)
}
HDInstallCancellationHandlers()
func waitInput(_ milliseconds: Int) throws {
    var remaining = milliseconds
    while remaining > 0 {
        if HDInputCancelled() != 0 { throw CancellationError() }
        let slice = min(remaining, 10)
        Thread.sleep(forTimeInterval: Double(slice)/1000)
        remaining -= slice
    }
    if HDInputCancelled() != 0 { throw CancellationError() }
}
func point(_ value: Any?) throws -> Point {
    guard let data = value as? [String: Any], let x = data["x"] as? Double, let y = data["y"] as? Double else { throw InputFailure("point", "A point needs numeric x and y coordinates.") }
    return Point(x: x, y: y)
}
func sendKeys(_ usages: [UInt64], connection: HDSimulatorConnection) throws {
    var held: [UInt64] = []
    defer { for usage in held.reversed() { try? connection.sendPayload(["usageCode": usage, "state": UInt64(2)], messageType: "IndigoKeyboardButtonEvent", barrier: false) } }
    for usage in usages { if HDInputCancelled() != 0 { throw CancellationError() }; try connection.sendPayload(["usageCode": usage, "state": UInt64(1)], messageType: "IndigoKeyboardButtonEvent", barrier: false); held.append(usage) }
    for usage in held.reversed() { try connection.sendPayload(["usageCode": usage, "state": UInt64(2)], messageType: "IndigoKeyboardButtonEvent", barrier: false) }
    held = []
}
func selectedDeveloperDirectory() throws -> String {
    let directory: String
    if let explicit = ProcessInfo.processInfo.environment["DEVELOPER_DIR"] { directory = explicit }
    else {
        let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select"); process.arguments = ["-p"]
        let output = Pipe(); process.standardOutput = output; process.standardError = FileHandle.nullDevice
        try process.run(); process.waitUntilExit()
        directory = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
    let versionURL = URL(fileURLWithPath: directory).deletingLastPathComponent().appendingPathComponent("version.plist")
    let version = (try? Data(contentsOf: versionURL)).flatMap { try? PropertyListSerialization.propertyList(from: $0, format: nil) as? [String: Any] }
    let major = (version?["CFBundleShortVersionString"] as? String)?.split(separator: ".").first.flatMap { Int($0) } ?? 0
    guard major >= 27 else { throw InputFailure("xcode", "iOS Simulator control requires Xcode; install and open Xcode, then select it in Settings › Locations › Command Line Tools.") }
    return directory
}
if CommandLine.arguments.contains("--probe") {
    do {
        let directory = try selectedDeveloperDirectory()
        var failure: NSError?
        guard HDProbeXcode(directory, &failure) else { throw failure ?? InputFailure("frameworks", "The simulator frameworks could not be loaded.") }
        print("{\"protocolVersion\":1,\"frameworks\":\"available\"}")
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("The selected Xcode simulator input frameworks could not be loaded.\n".utf8)); exit(1)
    }
}
while let line = readLine() {
    var id = ""
    do {
        guard line.utf8.count <= 100_000, let data = line.data(using: .utf8), let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw InputFailure("request", "Expected a bounded JSON request.") }
        guard let requestId = request["id"] as? String, !requestId.isEmpty else { throw InputFailure("request", "A request ID is required.") }; id = requestId
        guard request["protocolVersion"] as? Int == 1 else { throw InputFailure("version", "The simulator helper protocol version is incompatible.") }
        guard let udid = request["udid"] as? String, UUID(uuidString: udid) != nil else { throw InputFailure("target", "A concrete simulator UUID is required.") }
        let directory = try selectedDeveloperDirectory()
        let connection = try establish(xcodeMajor: 27) { _ in try HDSimulatorConnection(developerDirectory: directory, udid: udid) }
        defer { connection.close() }
        guard let operation = request["operation"] as? String, ["probe", "interact"].contains(operation) else { throw InputFailure("operation", "An input operation is required.") }
        var result: [String: Any] = ["transport": "dtuhid", "width": connection.pixelWidth, "height": connection.pixelHeight]
        if operation != "probe" {
            guard let action = request["action"] as? [String: Any], let kind = action["kind"] as? String else { throw InputFailure("action", "A typed input action is required.") }
            let duration = action["durationMs"] as? Int ?? 100
            let pixelInput = ["tap", "longPress", "swipe", "drag", "pinch", "rotateGesture"].contains(kind)
            let geometryData = request["geometry"] as? [String: Any]
            let rotation = geometryData?["rotation"] as? Int ?? -1
            let rotated = rotation == 1 || rotation == 3
            let width = rotated ? connection.pixelHeight : connection.pixelWidth
            let height = rotated ? connection.pixelWidth : connection.pixelHeight
            if pixelInput {
                guard (0...3).contains(rotation), geometryData?["width"] as? Double == width, geometryData?["height"] as? Double == height else { throw InputFailure("geometry", "The simulator display geometry is missing or stale; capture a fresh frame.") }
            }
            let geometry = Geometry(width: width, height: height, rotation: rotation)
            var samples: [Sample] = []
            switch kind {
            case "tap", "longPress":
                let p = try point(action)
                samples = try Gesture.samples(from: [p], to: [p], durationMs: kind == "tap" ? 80 : duration)
            case "swipe": samples = try Gesture.samples(from: [point(action["from"])], to: [point(action["to"])], durationMs: duration)
            case "pinch":
                let center = try point(action["center"])
                guard let start = action["startDistance"] as? Double, let end = action["endDistance"] as? Double, start > 0, end > 0 else { throw InputFailure("pinch", "Pinch distances must be positive screenshot pixels.") }
                samples = try Gesture.samples(from: [Point(x: center.x-start/2, y: center.y), Point(x: center.x+start/2, y: center.y)], to: [Point(x: center.x-end/2, y: center.y), Point(x: center.x+end/2, y: center.y)], durationMs: duration)
            case "drag":
                guard let path = action["path"] as? [[String: Any]] else { throw InputFailure("path", "A drag needs a timed path.") }
                samples = try Gesture.drag(path.map { sample in
                    guard let t = sample["tMs"] as? Int else { throw InputFailure("path", "Drag sample times must be integer milliseconds.") }
                    return try Sample(phase: .position, points: [point(sample)], tMs: t)
                })
            case "rotateGesture":
                guard let radius = action["radius"] as? Double, let degrees = action["angleDegrees"] as? Double else { throw InputFailure("rotation", "A rotation needs a radius and angle.") }
                samples = try Gesture.rotation(center: point(action["center"]), radius: radius, degrees: degrees, durationMs: duration)
            case "keyboard": throw InputFailure("keyboard", "Software keyboard show and hide are unavailable because simulator-local visibility observation has not been verified.")
            case "rotateDevice": throw InputFailure("orientation", "Device rotation is unavailable because its idempotent native delivery has not been verified on this Xcode.")
            case "button":
                guard let button = action["button"] as? String, ["home", "side", "lock"].contains(button), (1...10000).contains(duration) else { throw InputFailure("button", "Choose a supported hardware button and a bounded duration.") }
                if button == "lock" { throw InputFailure("lock", "Deterministic device locking is unavailable because native locked-state delivery could not be verified on this Xcode.") }
                let usage: UInt64 = button == "home" ? 0x40 : 0x30
                if HDInputCancelled() != 0 { throw CancellationError() }
                try connection.sendPayload(["usagePage": UInt64(12), "usageCode": usage, "state": UInt64(1)], messageType: "IndigoButtonEvent", barrier: false)
                defer { try? connection.sendPayload(["usagePage": UInt64(12), "usageCode": usage, "state": UInt64(2)], messageType: "IndigoButtonEvent", barrier: false) }
                try waitInput(duration)
            case "key":
                let count = action["count"] as? Int ?? 1
                guard let key = action["key"] as? String, (1...100).contains(count) else { throw InputFailure("key", "A key needs a count between 1 and 100.") }
                let usages = try keyboardUsage(key)
                for _ in 0..<count { try sendKeys(usages, connection: connection) }
            case "text":
                guard let text = action["text"] as? String, !text.isEmpty, text.utf8.count <= 16384 else { throw InputFailure("text", "Text must contain between 1 and 16384 bytes.") }
                let characters = try asciiUsages(text)
                try connection.verifyUsKeyboard()
                for usages in characters { try sendKeys(usages, connection: connection) }
                result["method"] = "hid-us-layout"
            default: throw InputFailure("unsupported", "This simulator input operation has not been verified.")
            }
            // Validate every contact before any event can be delivered.
            let normalized = try samples.map { sample in Sample(phase: sample.phase, points: try sample.points.map(geometry.normalize), tMs: sample.tMs) }
            if pixelInput { try connection.verifyRotation(rotation) }
            try Gesture.deliver(normalized, sink: { sample in
                if sample.phase != .end && HDInputCancelled() != 0 { throw CancellationError() }
                var payload: [String: Any] = ["eventType": sample.phase.rawValue, "edge": UInt64(0), "target": UInt64(0), "pointOne": ["x": sample.points[0].x, "y": sample.points[0].y]]
                if sample.points.count == 2 { payload["pointTwo"] = ["x": sample.points[1].x, "y": sample.points[1].y] }
                try connection.sendPayload(payload, messageType: "IndigoDigitizerEvent", barrier: false)
            }, sleep: waitInput)
            Thread.sleep(forTimeInterval: 0.08)
        }
        let response: [String: Any] = ["id": id, "protocolVersion": 1, "result": result]
        print(String(data: try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]), encoding: .utf8)!)
    } catch {
        let response: [String: Any] = ["id": id, "protocolVersion": 1, "error": ["code": (error as? InputFailure)?.code ?? "native", "message": (error as? InputFailure)?.description ?? (error as NSError).localizedDescription]]
        if let data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]), let output = String(data: data, encoding: .utf8) { print(output) }
    }
    fflush(stdout)
    if HDInputCancelled() != 0 { break }
}
