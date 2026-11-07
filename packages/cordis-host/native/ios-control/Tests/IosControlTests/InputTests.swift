import XCTest
import SimulatorBridge
@testable import IosControl
final class InputTests: XCTestCase {
    func testExactSingleAndTwoContactPhases() throws {
        let one = try Gesture.samples(from: [Point(x: 100, y: 200)], to: [Point(x: 200, y: 300)], durationMs: 32)
        XCTAssertEqual(one.map(\.phase), [.start, .position, .end])
        let two = try Gesture.samples(from: [Point(x: 100, y: 200), Point(x: 300, y: 200)], to: [Point(x: 50, y: 200), Point(x: 350, y: 200)], durationMs: 32)
        XCTAssertEqual(two.map(\.phase), [.start, .position, .end])
        XCTAssertTrue(two.allSatisfy { $0.points.count == 2 })
        XCTAssertEqual(two.last?.points, [Point(x: 50, y: 200), Point(x: 350, y: 200)])
    }
    func testAllFourOrientationTransforms() throws {
        for (rotation, expected) in [(0, Point(x: 0.2, y: 0.3)), (1, Point(x: 0.3, y: 0.8)), (2, Point(x: 0.8, y: 0.7)), (3, Point(x: 0.7, y: 0.2))] {
            let p = try Geometry(width: 100, height: 200, rotation: rotation).normalize(Point(x: 20, y: 60))
            XCTAssertEqual(p.x, expected.x, accuracy: 0.0001)
            XCTAssertEqual(p.y, expected.y, accuracy: 0.0001)
        }
        XCTAssertThrowsError(try Geometry(width: 100, height: 200, rotation: 0).normalize(Point(x: 100, y: 0)))
    }
    func testModernToolchainNeverFallsBack() throws {
        var attempts: [String] = []
        XCTAssertThrowsError(try establish(xcodeVersion: ["CFBundleShortVersionString": "27.1"]) { name in attempts.append(name); throw InputFailure("unavailable", "DTUHID did not answer.") })
        XCTAssertEqual(attempts, ["dtuhid"])
    }
    func testCancellationReleasesContacts() throws {
        var events: [Phase] = []
        var sleeps = 0
        XCTAssertThrowsError(try Gesture.deliver(try Gesture.samples(from: [Point(x: 0, y: 0)], to: [Point(x: 1, y: 1)], durationMs: 32), sink: { events.append($0.phase) }, sleep: { _ in sleeps += 1; throw CancellationError() }))
        XCTAssertEqual(sleeps, 1)
        XCTAssertEqual(events, [.start, .end])
    }

}
extension InputTests {
    func testTimedDragRejectsNonIncreasingSamples() throws {
        XCTAssertThrowsError(try Gesture.drag([Sample(phase:.position,points:[Point(x:0,y:0)],tMs:0),Sample(phase:.position,points:[Point(x:1,y:1)],tMs:0)]))
        let samples = try Gesture.drag([Sample(phase:.position,points:[Point(x:0,y:0)],tMs:0),Sample(phase:.position,points:[Point(x:1,y:1)],tMs:50)])
        XCTAssertEqual(samples.map(\.phase),[.start,.end])
    }
    func testPositiveRotationIsClockwise() throws {
        let samples=try Gesture.rotation(center:Point(x:100,y:100),radius:50,degrees:90,durationMs:32)
        XCTAssertEqual(samples.first!.points[0],Point(x:150,y:100))
        XCTAssertEqual(samples.last!.points[0].x,100,accuracy:0.0001)
        XCTAssertEqual(samples.last!.points[0].y,150,accuracy:0.0001)
        XCTAssertEqual(samples.last!.points[1].y,50,accuracy:0.0001)
    }
}
extension InputTests {
    func testHoldIsExactlyDownThenUp() throws {
        let point=Point(x:10,y:20)
        let samples=try Gesture.samples(from:[point],to:[point],durationMs:750)
        XCTAssertEqual(samples.map(\.phase),[.start,.end])
        XCTAssertEqual(samples.map(\.tMs),[0,750])
    }
}

extension InputTests {
    func testFreshUsKeyboardDefaultsWithoutPreferenceWrites() {
        let preferences: [String: Any] = ["DictationLanguagesEnabled": ["en_US"]]
        let global: [String: Any] = ["AppleLocale": "en_US", "AppleLanguages": ["en-US"], "ApplePasscodeKeyboards": ["en_US", "emoji"]]
        XCTAssertTrue(HDUsesUsKeyboard(preferences, global))
        XCTAssertTrue(HDUsesUsKeyboard(preferences, global.merging(["AppleKeyboards": []]) { _, new in new }))
    }
    func testExplicitNonUsAndUnknownKeyboardDefaultsRefuse() {
        XCTAssertFalse(HDUsesUsKeyboard(["KeyboardsCurrentAndNext": ["fr_FR@sw=AZERTY;hw=Automatic"]], ["AppleLocale": "en_US"]))
        XCTAssertFalse(HDUsesUsKeyboard([:], [:]))
        XCTAssertFalse(HDUsesUsKeyboard([:], ["AppleLocale": "fr_FR"]))
        XCTAssertFalse(HDUsesUsKeyboard([:], ["AppleLocale": "en_US", "AppleKeyboards": ["fr_FR@sw=AZERTY;hw=Automatic"]]))
        XCTAssertTrue(HDUsesUsKeyboard(["KeyboardsCurrentAndNext": ["en_US@sw=QWERTY;hw=US"]], [:]))
    }
}

extension InputTests {
    func testActualXcodeVersionGate() throws {
        var connected = false
        XCTAssertThrowsError(try establish(xcodeVersion: ["CFBundleShortVersionString": "26.4"]) { _ in connected = true; return 1 })
        XCTAssertFalse(connected)
        XCTAssertEqual(try establish(xcodeVersion: ["CFBundleShortVersionString": "27.1"]) { $0 }, "dtuhid")
        XCTAssertThrowsError(try establish(xcodeVersion: [:]) { $0 })
    }
    func testRefusedActionsNeverConnect() {
        for action: [String: Any] in [["kind": "keyboard"], ["kind": "rotateDevice"], ["kind": "button", "button": "lock"]] {
            var connected = false
            XCTAssertThrowsError(try withInputConnection(action: action, connect: { connected = true; return 1 }, reset: { _ in }))
            XCTAssertFalse(connected)
        }
    }
    func testNewConnectionReleasesBothContactsBeforeAction() throws {
        var calls: [String] = []
        let transport = InputTransport(cancelled: { false }, send: { payload, type, wait in
            XCTAssertEqual(type, "IndigoDigitizerEvent")
            XCTAssertEqual(payload["eventType"] as? UInt64, 2)
            XCTAssertNotNil(payload["pointOne"]); XCTAssertNotNil(payload["pointTwo"])
            XCTAssertFalse(wait)
            calls.append("release")
        })
        _ = try withInputConnection(action: ["kind": "tap"], connect: { calls.append("connect"); return transport }, reset: { try $0.releaseContacts() })
        calls.append("action")
        XCTAssertEqual(calls, ["connect", "release", "action"])
    }
    func testCancellationReleaseDoesNotWaitForAcknowledgement() throws {
        var cancelled = false
        var waits: [Bool] = []
        let transport = InputTransport(cancelled: { cancelled }, send: { _, _, wait in waits.append(wait) })
        let samples = try Gesture.samples(from: [Point(x: 0, y: 0)], to: [Point(x: 1, y: 1)], durationMs: 32)
        XCTAssertThrowsError(try Gesture.deliver(samples, sink: { try transport.contact($0) }, sleep: { _ in cancelled = true; throw CancellationError() }))
        XCTAssertEqual(waits, [true, false])
    }
}
extension InputTests {
    func testCancelledStartAcknowledgementStillReleasesContact() throws {
        var phases: [Phase] = []
        let samples = try Gesture.samples(from: [Point(x: 0, y: 0)], to: [Point(x: 1, y: 1)], durationMs: 32)
        XCTAssertThrowsError(try Gesture.deliver(samples, sink: { sample in
            phases.append(sample.phase)
            if sample.phase == .start { throw CancellationError() }
        }, sleep: { _ in }))
        XCTAssertEqual(phases, [.start, .end])
    }
}
extension InputTests {
    func testCancelledKeyAndButtonAcknowledgementsReleaseHeldInputs() throws {
        for type in ["key", "button"] {
            var cancelled = false, states: [UInt64] = [], waits: [Bool] = []
            let transport = InputTransport(cancelled: { cancelled }, send: { payload, _, wait in
                states.append(payload["state"] as! UInt64); waits.append(wait)
                if states.count == 1 { cancelled = true; throw CancellationError() }
            })
            if type == "key" { XCTAssertThrowsError(try transport.keys([225, 4])) }
            else { XCTAssertThrowsError(try transport.button(0x40, duration: 100, sleep: { _ in })) }
            XCTAssertEqual(states, [1, 2]); XCTAssertEqual(waits, [true, false])
        }
    }
}
