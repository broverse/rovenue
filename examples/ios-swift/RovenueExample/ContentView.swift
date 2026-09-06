// ContentView.swift — the demonstrated flow's home screen:
//   configure (in HomeViewModel.bootstrap, on .task) -> identify ->
//   offerings -> paywall -> purchase -> entitlement reaction -> restore,
//   plus the on-screen event log.
import Rovenue
import SwiftUI

struct ContentView: View {
    @StateObject private var viewModel = HomeViewModel()
    @State private var showPaywall = false
    @State private var activePaywall: Paywall?

    var body: some View {
        NavigationView {
            Group {
                if viewModel.configuring {
                    ProgressView("Configuring…")
                } else {
                    List {
                        identitySection
                        entitlementsSection
                        offeringsSection
                        paywallSection
                        logSection
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Rovenue Example")
            .overlay(alignment: .bottom) {
                if let busyLabel = viewModel.busyLabel {
                    BusyBanner(label: busyLabel)
                }
            }
        }
        .task {
            await viewModel.bootstrap()
        }
        .sheet(isPresented: $showPaywall) {
            if let activePaywall {
                PaywallSheet(paywall: activePaywall, viewModel: viewModel, isPresented: $showPaywall)
            }
        }
    }

    // MARK: - Sections

    private var identitySection: some View {
        Section("Identity") {
            LabeledContent("rovenueId", value: viewModel.currentUser?.rovenueId ?? "loading…")
            LabeledContent("appUserId", value: viewModel.currentUser?.appUserId ?? "(anonymous)")
            TextField("appUserId to identify", text: $viewModel.appUserIdInput)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            HStack {
                Button("Identify") {
                    Task { await viewModel.identify() }
                }
                .disabled(viewModel.appUserIdInput.trimmingCharacters(in: .whitespaces).isEmpty)
                Spacer()
                Button("Log out") {
                    Task { await viewModel.logOut() }
                }
            }
        }
    }

    private var entitlementsSection: some View {
        Section("Entitlements") {
            if viewModel.entitlements.isEmpty {
                Text("(none)").foregroundStyle(.secondary)
            } else {
                ForEach(viewModel.entitlements, id: \.id) { entitlement in
                    VStack(alignment: .leading) {
                        Text(entitlement.id).font(.headline)
                        Text("active: \(entitlement.isActive ? "true" : "false") · expires: \(entitlement.expiresIso ?? "-")")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Button("Refresh entitlements") {
                Task { await viewModel.refreshEntitlementsFromNetwork() }
            }
            Button("Restore purchases") {
                Task { await viewModel.restore() }
            }
        }
    }

    private var offeringsSection: some View {
        Section("Products") {
            if viewModel.products.isEmpty {
                Text("(no offerings loaded)").foregroundStyle(.secondary)
                Button("Load offerings") {
                    Task { await viewModel.loadOfferings() }
                }
            } else {
                ForEach(viewModel.products, id: \.id) { product in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(product.displayName).font(.headline)
                            Text(product.priceString ?? product.id)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Purchase") {
                            Task { await viewModel.purchase(product) }
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
            }
        }
    }

    private var paywallSection: some View {
        Section("Paywall") {
            Button("Open paywall (\(ExampleConfig.placementIdentifier))") {
                Task {
                    if let paywall = await viewModel.resolvePaywall() {
                        activePaywall = paywall
                        showPaywall = true
                    }
                }
            }
        }
    }

    private var logSection: some View {
        Section("Log") {
            ForEach(Array(viewModel.log.enumerated()), id: \.offset) { _, line in
                Text(line)
                    .font(.system(.caption, design: .monospaced))
            }
        }
    }
}

private struct BusyBanner: View {
    let label: String

    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
            Text("\(label)…")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.thinMaterial, in: Capsule())
        .padding(.bottom, 16)
    }
}
