// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "FounderMobile",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "FounderMobileIntents",
            targets: ["FounderMobileIntents"]
        ),
        .library(
            name: "FounderMobileApp",
            targets: ["FounderMobileApp"]
        )
    ],
    targets: [
        .target(
            name: "FounderMobileIntents",
            path: "AppIntents"
        ),
        .target(
            name: "FounderMobileApp",
            dependencies: ["FounderMobileIntents"],
            path: "App"
        ),
        .testTarget(
            name: "FounderMobileIntentsTests",
            dependencies: ["FounderMobileIntents", "FounderMobileApp"]
        )
    ]
)
