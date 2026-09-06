// PaywallSheet.swift — hosts `RovenuePaywallView` for the paywall resolved
// by `HomeViewModel.resolvePaywall()`, wiring all five callbacks to an
// on-screen event log. Mirrors the Flutter example's `PaywallScreen`.
import Rovenue
import SwiftUI

struct PaywallSheet: View {
    let paywall: Paywall
    @ObservedObject var viewModel: HomeViewModel
    @Binding var isPresented: Bool

    @State private var events: [String] = []

    var body: some View {
        VStack(spacing: 0) {
            RovenuePaywallView(
                paywall: paywall,
                onPurchaseCompleted: { result in
                    logEvent("onPurchaseCompleted: \(result.productId)")
                    Task { @MainActor in
                        await viewModel.loadOfferings()
                    }
                },
                onPurchaseFailed: { error in
                    if let e = error as? RovenueError {
                        logEvent("onPurchaseFailed: RovenueError(\(e.kind)): \(e.message)")
                    } else {
                        logEvent("onPurchaseFailed: \(error)")
                    }
                },
                onClose: {
                    logEvent("onClose")
                    isPresented = false
                },
                onRestore: {
                    logEvent("onRestore")
                    Task { await viewModel.restore() }
                },
                onUrl: { url in
                    logEvent("onUrl: \(url.absoluteString)")
                }
            )

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(events.enumerated()), id: \.offset) { _, line in
                        Text(line).font(.system(.caption2, design: .monospaced))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
            }
            .frame(height: 120)
            .background(Color(.secondarySystemBackground))
        }
    }

    private func logEvent(_ line: String) {
        events.insert(line, at: 0)
        viewModel.appendLog("paywall: \(line)")
    }
}
