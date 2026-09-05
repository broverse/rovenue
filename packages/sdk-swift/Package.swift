// swift-tools-version: 5.9
import PackageDescription

// RovenueFFI.xcframework is a build artifact, not a checked-in binary — run
// packages/sdk-swift/scripts/build-xcframework.sh before building this package.
//
// It is a `binaryTarget` rather than a `systemLibrary` + `-L` linker flag on
// purpose: SwiftPM refuses a version-based dependency whose product contains a
// target with unsafe linker flags, so the previous manifest could never be
// consumed by an external package at all.
let package = Package(
    name: "Rovenue",
    platforms: [.iOS(.v16), .macOS(.v12)],
    products: [
        .library(name: "Rovenue", targets: ["Rovenue"]),
    ],
    targets: [
        .binaryTarget(
            name: "RovenueFFI",
            path: "RovenueFFI.xcframework"
        ),
        .target(
            name: "Rovenue",
            dependencies: ["RovenueFFI"],
            path: "Sources/Rovenue",
            resources: [.copy("PrivacyInfo.xcprivacy")]
        ),
        .testTarget(
            name: "RovenueTests",
            dependencies: ["Rovenue"],
            path: "Tests/RovenueTests"
        ),
    ]
)
