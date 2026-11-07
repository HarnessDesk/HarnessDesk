import XCTest
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
        XCTAssertThrowsError(try establish(xcodeMajor: 27) { name in attempts.append(name); throw InputFailure("unavailable", "DTUHID did not answer.") })
        XCTAssertEqual(attempts, ["dtuhid"])
    }
    func testCancellationReleasesContacts() throws {
        var events: [Phase] = []
        var sleeps = 0
        XCTAssertThrowsError(try Gesture.deliver(try Gesture.samples(from: [Point(x: 0, y: 0)], to: [Point(x: 1, y: 1)], durationMs: 32), sink: { events.append($0.phase) }, sleep: { _ in sleeps += 1; throw CancellationError() }))
        XCTAssertEqual(sleeps, 1)
        XCTAssertEqual(events, [.start, .end])
    }
    func testMissingSymbolsReturnSentence() {
        XCTAssertThrowsError(try requireSymbols(["one", "two"], resolve: { $0 == "one" })) { error in
            XCTAssertEqual(String(describing: error), "The installed Xcode is missing the simulator input symbol two.")
        }
    }
}
