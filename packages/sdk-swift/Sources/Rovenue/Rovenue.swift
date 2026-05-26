import Foundation

// The Generated/ folder (populated by build-bindings.sh) brings RovenueCore,
// Config, RovenueError, sdkVersion() into the Rovenue module namespace.
// For M0 the generated types are re-exported as-is so the smoke test can run.
// M1+ will wrap these in an idiomatic Swift actor + AsyncStream façade.

public enum RovenueModule {
    public static let version: String = sdkVersion()
}
