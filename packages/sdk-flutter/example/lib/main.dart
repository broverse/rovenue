// Rovenue Flutter SDK example app (Task 8).
//
// Exercises the public `rovenue_flutter` surface end-to-end: configure() ->
// getOfferings() -> a purchase button per product -> entitlementsAll() kept
// live via the `changes` stream -> a route mounting `RovenuePaywallView`
// with all five callbacks logging to screen.
//
// This app is NOT wired to a real Rovenue project — `_apiKey` below is a
// placeholder. Every SDK call is wrapped in try/catch and its outcome
// (success or failure) is appended to the on-screen log, so the app is
// useful to poke at even without a live backend. `integration_test/
// smoke_test.dart` swaps `RovenuePlatform.instance` for a fake before
// `runApp` so it needs neither a backend nor a device/simulator.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:rovenue_flutter/rovenue_flutter.dart';

void main() {
  runApp(const RovenueExampleApp());
}

class RovenueExampleApp extends StatelessWidget {
  const RovenueExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Rovenue Flutter Example',
      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
      home: const HomeScreen(),
    );
  }
}

/// Placeholder public API key — replace with a real project key from your
/// Rovenue dashboard to exercise this app against a live backend.
const String _kApiKey = 'rk_test_example_public_key';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  bool _configuring = true;
  Offerings? _offerings;
  List<Entitlement> _entitlements = const <Entitlement>[];
  final List<String> _log = <String>[];
  StreamSubscription<RovenueChangeEvent>? _changesSub;

  @override
  void initState() {
    super.initState();
    unawaited(_bootstrap());
  }

  @override
  void dispose() {
    unawaited(_changesSub?.cancel());
    super.dispose();
  }

  Future<void> _bootstrap() async {
    try {
      await Rovenue.instance.configure(apiKey: _kApiKey, logLevel: RovenueLogLevel.info);
      _appendLog('configure() succeeded');
      // The SDK's own "go re-fetch" signal — kept alive for the app's
      // lifetime, not just while this screen is visible, matching how a
      // real app would drive its entitlement-gated UI.
      _changesSub = Rovenue.instance.changes.listen((event) {
        _appendLog('onChange: ${event.kind}');
        unawaited(_refreshEntitlements());
      });
      await _refreshEntitlements();
      await _loadOfferings();
    } catch (e) {
      _appendLog('configure() failed: $e');
    } finally {
      if (mounted) setState(() => _configuring = false);
    }
  }

  Future<void> _refreshEntitlements() async {
    try {
      final entitlements = await Rovenue.instance.entitlementsAll();
      if (mounted) setState(() => _entitlements = entitlements);
    } catch (e) {
      _appendLog('entitlementsAll() failed: $e');
    }
  }

  Future<void> _loadOfferings() async {
    try {
      final offerings = await Rovenue.instance.getOfferings();
      if (mounted) setState(() => _offerings = offerings);
      _appendLog('getOfferings() succeeded: ${offerings.offerings.length} offering(s)');
    } catch (e) {
      _appendLog('getOfferings() failed: $e');
    }
  }

  Future<void> _purchase(StoreProduct product) async {
    try {
      final result = await Rovenue.instance.purchase(product);
      _appendLog('purchase(${product.id}) succeeded: txn ${result.storeTransactionId}');
      await _refreshEntitlements();
    } catch (e) {
      _appendLog('purchase(${product.id}) failed: $e');
    }
  }

  void _appendLog(String line) {
    if (!mounted) return;
    setState(() => _log.insert(0, line));
  }

  List<StoreProduct> get _products => <StoreProduct>[
        for (final offering in _offerings?.offerings ?? const <Offering>[])
          for (final package in offering.packages) package.product,
      ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Rovenue Flutter Example')),
      body: _configuring
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: <Widget>[
                Text('Entitlements', style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 8),
                if (_entitlements.isEmpty)
                  const Text('(none)')
                else
                  for (final entitlement in _entitlements)
                    Card(
                      child: ListTile(
                        title: Text(entitlement.id),
                        subtitle: Text(
                          'active: ${entitlement.active} · expiresAt: ${entitlement.expiresAt ?? '-'}',
                        ),
                      ),
                    ),
                const SizedBox(height: 24),
                Text('Products', style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 8),
                if (_products.isEmpty)
                  const Text('(no offerings loaded)')
                else
                  for (final product in _products)
                    Card(
                      child: ListTile(
                        title: Text(product.displayName),
                        subtitle: Text(product.priceString ?? product.id),
                        trailing: ElevatedButton(
                          onPressed: () => unawaited(_purchase(product)),
                          child: const Text('Purchase'),
                        ),
                      ),
                    ),
                const SizedBox(height: 24),
                ElevatedButton(
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => const PaywallScreen(placementIdentifier: 'onboarding'),
                    ),
                  ),
                  child: const Text('Open paywall (onboarding)'),
                ),
                const SizedBox(height: 24),
                Text('Log', style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 8),
                for (final line in _log)
                  Text(line, style: Theme.of(context).textTheme.bodySmall),
              ],
            ),
    );
  }
}

/// Hosts [RovenuePaywallView] for [placementIdentifier], wiring all five
/// callbacks to an on-screen event log.
class PaywallScreen extends StatefulWidget {
  const PaywallScreen({super.key, required this.placementIdentifier});

  final String placementIdentifier;

  @override
  State<PaywallScreen> createState() => _PaywallScreenState();
}

class _PaywallScreenState extends State<PaywallScreen> {
  final List<String> _events = <String>[];

  void _logEvent(String line) {
    if (!mounted) return;
    setState(() => _events.insert(0, line));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('Paywall: ${widget.placementIdentifier}')),
      body: Column(
        children: <Widget>[
          Expanded(
            child: RovenuePaywallView(
              placementIdentifier: widget.placementIdentifier,
              onPurchaseCompleted: (result) =>
                  _logEvent('onPurchaseCompleted: ${result.productId}'),
              onPurchaseFailed: (error) => _logEvent('onPurchaseFailed: ${error.kind}'),
              onClose: () {
                _logEvent('onClose');
                Navigator.of(context).maybePop();
              },
              onRestore: () => _logEvent('onRestore'),
              onUrl: (url) => _logEvent('onUrl: $url'),
            ),
          ),
          Container(
            height: 140,
            width: double.infinity,
            color: Theme.of(context).colorScheme.surfaceContainerHighest,
            padding: const EdgeInsets.all(8),
            child: ListView(
              children: <Widget>[
                for (final event in _events) Text(event),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
