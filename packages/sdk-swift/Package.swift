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
    dependencies: [
        // Doc-only, dev-time dependency (ROADMAP §11): drives
        // `swift package generate-documentation`, producing a .doccarchive
        // from Sources/Rovenue/Rovenue.docc. Not linked into the Rovenue
        // library target, so it adds nothing to consumers' builds.
        .package(url: "https://github.com/apple/swift-docc-plugin", from: "1.3.0"),
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
