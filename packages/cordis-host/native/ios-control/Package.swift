// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "IosControl", platforms: [.macOS(.v14)], products: [.executable(name: "hd-ios-control", targets: ["IosControl"])], targets: [
    .target(name: "SimulatorBridge", linkerSettings: [.linkedFramework("Foundation"), .linkedFramework("CoreGraphics")]),
    .executableTarget(name: "IosControl", dependencies: ["SimulatorBridge"]),
    .testTarget(name: "IosControlTests", dependencies: ["IosControl"]),
], swiftLanguageModes: [.v5])
