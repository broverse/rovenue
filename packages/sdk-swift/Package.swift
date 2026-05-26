// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Rovenue",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "Rovenue", targets: ["Rovenue"]),
    ],
    targets: [
        .systemLibrary(
            name: "RovenueFFI",
            path: "Sources/RovenueFFI"
        ),
        .target(
            name: "Rovenue",
            dependencies: ["RovenueFFI"],
            path: "Sources/Rovenue",
            linkerSettings: [
                .linkedLibrary("rovenue"),
                .unsafeFlags(["-L../../target/release"], .when(platforms: [.macOS])),
            ]
        ),
        .testTarget(
            name: "RovenueTests",
            dependencies: ["Rovenue"],
            path: "Tests/RovenueTests"
        ),
    ]
)
