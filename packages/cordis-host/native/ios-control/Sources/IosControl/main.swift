import Foundation
import SimulatorBridge
if CommandLine.arguments.contains("--version") { print("{\"protocolVersion\":1,\"name\":\"hd-ios-control\"}"); exit(0) }
if CommandLine.arguments.contains("--pointer") {
    let data = try JSONSerialization.data(withJSONObject: HDSimulatorConnection.pointerPosition(), options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!); exit(0)
}
func point(_ value: Any?) throws -> Point {
    guard let data = value as? [String: Any], let x = data["x"] as? Double, let y = data["y"] as? Double else { throw InputFailure("point", "A point needs numeric x and y coordinates.") }
    return Point(x: x, y: y)
}
func sendKeys(_ usages: [UInt64], connection: HDSimulatorConnection) throws {
    var held: [UInt64] = []
    defer { for usage in held.reversed() { try? connection.sendPayload(["usageCode": usage, "state": UInt64(2)], messageType: "IndigoKeyboardButtonEvent", barrier: false) } }
    for usage in usages { try connection.sendPayload(["usageCode": usage, "state": UInt64(1)], messageType: "IndigoKeyboardButtonEvent", barrier: false); held.append(usage) }
    for usage in held.reversed() { try connection.sendPayload(["usageCode": usage, "state": UInt64(2)], messageType: "IndigoKeyboardButtonEvent", barrier: false) }
    held = []
}
while let line = readLine() {
    var id = ""
    do {
        guard line.utf8.count <= 100_000, let data = line.data(using: .utf8), let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw InputFailure("request", "Expected a bounded JSON request.") }
        guard let requestId = request["id"] as? String, !requestId.isEmpty else { throw InputFailure("request", "A request ID is required.") }; id = requestId
        guard request["protocolVersion"] as? Int == 1 else { throw InputFailure("version", "The simulator helper protocol version is incompatible.") }
        guard let udid = request["udid"] as? String, UUID(uuidString: udid) != nil else { throw InputFailure("target", "A concrete simulator UUID is required.") }
        guard let directory = ProcessInfo.processInfo.environment["DEVELOPER_DIR"] else { throw InputFailure("xcode", "Select Xcode before requesting simulator input.") }
        let connection = try HDSimulatorConnection(developerDirectory: directory, udid: udid)
        defer { connection.close() }
        guard let operation = request["operation"] as? String else { throw InputFailure("operation", "An input operation is required.") }
        var result: [String: Any] = ["transport": "dtuhid", "width": connection.pixelWidth, "height": connection.pixelHeight]
        if operation != "probe" {
            guard let action = request["action"] as? [String: Any], let kind = action["kind"] as? String else { throw InputFailure("action", "A typed input action is required.") }
            let duration = action["durationMs"] as? Int ?? 100
            let geometry = Geometry(width: connection.pixelWidth, height: connection.pixelHeight, rotation: 0)
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
            case "key":
                let count = action["count"] as? Int ?? 1
                guard let key = action["key"] as? String, (1...100).contains(count) else { throw InputFailure("key", "A key needs a count between 1 and 100.") }
                let usages = try keyboardUsage(key)
                for _ in 0..<count { try sendKeys(usages, connection: connection) }
            case "text":
                guard let text = action["text"] as? String, !text.isEmpty, text.utf8.count <= 16384 else { throw InputFailure("text", "Text must contain between 1 and 16384 bytes.") }
                let characters = try asciiUsages(text)
                for usages in characters { try sendKeys(usages, connection: connection) }
                result["method"] = "hid-us-layout"
            default: throw InputFailure("unsupported", "This simulator input operation has not been verified.")
            }
            // Validate every contact before any event can be delivered.
            let normalized = try samples.map { sample in Sample(phase: sample.phase, points: try sample.points.map(geometry.normalize), tMs: sample.tMs) }
            try Gesture.deliver(normalized, sink: { sample in
                var payload: [String: Any] = ["eventType": sample.phase.rawValue, "edge": UInt64(0), "target": UInt64(0), "pointOne": ["x": sample.points[0].x, "y": sample.points[0].y]]
                if sample.points.count == 2 { payload["pointTwo"] = ["x": sample.points[1].x, "y": sample.points[1].y] }
                try connection.sendPayload(payload, messageType: "IndigoDigitizerEvent", barrier: false)
            }, sleep: { Thread.sleep(forTimeInterval: Double($0)/1000) })
            Thread.sleep(forTimeInterval: 0.08)
        }
        let response: [String: Any] = ["id": id, "protocolVersion": 1, "result": result]
        print(String(data: try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]), encoding: .utf8)!)
    } catch {
        let response: [String: Any] = ["id": id, "protocolVersion": 1, "error": ["code": (error as? InputFailure)?.code ?? "native", "message": String(describing: error)]]
        if let data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]), let output = String(data: data, encoding: .utf8) { print(output) }
    }
    fflush(stdout)
}
