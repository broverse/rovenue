// The app-facing `Rovenue` singleton. Every method here forwards straight
// to `RovenuePlatform.instance`, re-shaped where the ergonomics differ from
// the wire/platform-interface layer (see `purchase` below) — matching the
// Swift/Kotlin façades rather than exposing the raw platform-interface
// shape. No `PlatformException`/`RovenueException` handling happens here:
// `RovenuePlatform`'s default `MethodChannelRovenue` implementation already
// guarantees only `RovenueException` ever escapes, so this class must not
// re-wrap or swallow it — it propagates unchanged.
import 'dart:async';

import 'package:rovenue_flutter_platform_interface/rovenue_flutter_platform_interface.dart';

import 'funnel_token.dart';

/// Rovenue's app-facing Dart API. Use the [instance] singleton.
///
/// `RovenuePlatform.instance` is read lazily (via [_platform]) on every
/// call — never cached in a field — so tests can swap
/// `RovenuePlatform.instance` for a fake at any point and this singleton
/// (constructed once, like any `static final`) immediately picks it up.
/// The three event streams ([changes], [logs], [funnelClaims]) apply the
/// same rule at the stream level: the underlying platform stream is
/// subscribed to lazily, exactly once, on the first Dart-side listener
/// (see `_StreamHub`), and re-read fresh the next time a listener attaches
/// after every previous one has cancelled.
class Rovenue {
  Rovenue._();

  static final Rovenue instance = Rovenue._();

  RovenuePlatform get _platform => RovenuePlatform.instance;

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  Future<void> configure({
    required String apiKey,
    String? baseUrl,
    RovenueLogLevel logLevel = RovenueLogLevel.warn,
    String? appVersion,
    String? environment,
  }) =>
      _platform.configure(
        apiKey: apiKey,
        baseUrl: baseUrl,
        logLevel: logLevel,
        appVersion: appVersion,
        environment: environment,
      );

  Future<void> shutdown() => _platform.shutdown();

  Future<void> setForeground(bool foreground) => _platform.setForeground(foreground);

  Future<String> getVersion() => _platform.getVersion();

  Future<String?> getAppVersion() => _platform.getAppVersion();

  // ---------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------

  Future<RovenueUser> currentUser() => _platform.currentUser();

  Future<void> identify(String appUserId) => _platform.identify(appUserId);

  Future<void> logOut() => _platform.logOut();

  // ---------------------------------------------------------------------
  // Entitlements
  // ---------------------------------------------------------------------

  Future<Entitlement?> entitlement(String id) => _platform.entitlement(id);

  Future<List<Entitlement>> entitlementsAll() => _platform.entitlementsAll();

  Future<void> refreshEntitlements() => _platform.refreshEntitlements();

  // ---------------------------------------------------------------------
  // Virtual currencies
  // ---------------------------------------------------------------------

  Future<Map<String, int>> virtualCurrencies() => _platform.virtualCurrencies();

  Future<int> virtualCurrency(String code) => _platform.virtualCurrency(code);

  Future<void> refreshVirtualCurrencies() => _platform.refreshVirtualCurrencies();

  // ---------------------------------------------------------------------
  // Purchases / placements
  // ---------------------------------------------------------------------

  Future<Offerings> getOfferings() => _platform.getOfferings();

  Future<Paywall?> getPaywall(String placementIdentifier, {String? locale}) =>
      _platform.getPaywall(placementIdentifier, locale: locale);

  Future<int> setFallbackPlacements(String json) => _platform.setFallbackPlacements(json);

  /// Purchases [product] (optionally via a specific Android [option]),
  /// unpacking `productId`/`productType`/`basePlanId`/`offerId` for the
  /// platform-interface call — callers work with the public [StoreProduct]
  /// / [SubscriptionOption] models, never raw ids, matching the Swift/Kotlin
  /// façades' ergonomics rather than the wire shape.
  Future<PurchaseResult> purchase(
    StoreProduct product, {
    String? promotionalOfferId,
    SubscriptionOption? option,
  }) =>
      _platform.purchase(
        product.id,
        product.type,
        promotionalOfferId: promotionalOfferId,
        basePlanId: option?.basePlanId,
        offerId: option?.offerId,
      );

  Future<PurchaseResult> restorePurchases() => _platform.restorePurchases();

  // ---------------------------------------------------------------------
  // Remote Config
  // ---------------------------------------------------------------------

  Future<void> refreshRemoteConfig() => _platform.refreshRemoteConfig();

  Future<bool> remoteConfigBool(String key, bool fallback) => _platform.remoteConfigBool(key, fallback);

  Future<String> remoteConfigString(String key, String fallback) =>
      _platform.remoteConfigString(key, fallback);

  Future<int> remoteConfigInt(String key, int fallback) => _platform.remoteConfigInt(key, fallback);

  Future<double> remoteConfigDouble(String key, double fallback) =>
      _platform.remoteConfigDouble(key, fallback);

  Future<String?> remoteConfigJson(String key) => _platform.remoteConfigJson(key);

  Future<List<String>> remoteConfigKeys() => _platform.remoteConfigKeys();

  Future<String> remoteConfigAllJson() => _platform.remoteConfigAllJson();

  Future<ExperimentAssignment?> experiment(String key) => _platform.experiment(key);

  Future<List<ExperimentAssignment>> experimentsAll() => _platform.experimentsAll();

  // ---------------------------------------------------------------------
  // Refund Shield
  // ---------------------------------------------------------------------

  Future<String> getAppAccountToken() => _platform.getAppAccountToken();

  Future<void> recordSessionEvent(
    SessionEventKind kind,
    String occurredAt, {
    int? durationMs,
  }) =>
      _platform.recordSessionEvent(kind, occurredAt, durationMs: durationMs);

  Future<int> flushSessionEvents() => _platform.flushSessionEvents();

  // ---------------------------------------------------------------------
  // Funnel attribution
  // ---------------------------------------------------------------------

  Future<FunnelClaim> claimFunnelToken(String token) => _platform.claimFunnelToken(token);

  Future<FunnelClaim?> claimInstall([ClaimInstallParams params = const ClaimInstallParams()]) =>
      _platform.claimInstall(params);

  Future<void> claimViaEmail(String email) => _platform.claimViaEmail(email);

  /// Reads a funnel token out of the system clipboard and claims it.
  ///
  /// **iOS only.** On Android this always resolves `null` without touching
  /// the clipboard: Android's deferred-attribution path is the Play Install
  /// Referrer, which [claimInstall] reads. Call both if you support both
  /// platforms — this one is a no-op on Android by design, not a bug.
  Future<FunnelClaim?> claimFromClipboard() => _platform.claimFromClipboard();

  Future<String> installId() => _platform.installId();

  Future<bool> hasResolvedFunnelClaim() => _platform.hasResolvedFunnelClaim();

  /// Claims the funnel token carried by [url] (a deep link / Universal
  /// Link), or resolves `null` without a network call for any non-funnel
  /// URL. Forward every incoming URL here from your app's link handler; see
  /// [extractFunnelToken] for the recognised shapes.
  Future<FunnelClaim?> claimFromUrl(String url) async {
    final token = extractFunnelToken(url);
    if (token == null) return null;
    return _platform.claimFunnelToken(token);
  }

  // ---------------------------------------------------------------------
  // Generic events
  // ---------------------------------------------------------------------

  Future<void> track(String envelopeJson) => _platform.track(envelopeJson);

  Future<void> enqueuePaywallEvent(String envelopeJson) => _platform.enqueuePaywallEvent(envelopeJson);

  // ---------------------------------------------------------------------
  // Subscriber attributes
  // ---------------------------------------------------------------------

  Future<void> setAttributes(Map<String, String?> attributes) => _platform.setAttributes(attributes);

  Future<void> setEmail(String? email) => _platform.setEmail(email);

  Future<void> setDisplayName(String? name) => _platform.setDisplayName(name);

  Future<void> setPhoneNumber(String? phone) => _platform.setPhoneNumber(phone);

  Future<void> setPushToken(String? token) => _platform.setPushToken(token);

  Future<int> flushAttributes() => _platform.flushAttributes();

  // ---------------------------------------------------------------------
  // Native -> Dart event streams
  // ---------------------------------------------------------------------

  final _StreamHub<RovenueChangeEvent> _changesHub =
      _StreamHub<RovenueChangeEvent>(() => RovenuePlatform.instance.changes);

  final _StreamHub<RovenueLogRecord> _logsHub =
      _StreamHub<RovenueLogRecord>(() => RovenuePlatform.instance.logs);

  final _StreamHub<FunnelClaim> _funnelClaimsHub =
      _StreamHub<FunnelClaim>(() => RovenuePlatform.instance.funnelClaims, replay: true);

  /// Broadcast stream of `onChange` events: something the SDK's local cache
  /// changed and the app should re-read it. Deliberately NOT given
  /// last-value replay (unlike [funnelClaims], see below): it is a "go
  /// re-fetch current state" signal whose target state is always
  /// re-readable on demand (`entitlementsAll()`, `remoteConfigAllJson()`,
  /// …), so a notification missed before a listener attaches costs
  /// nothing — the next explicit read already reflects the latest state.
  Stream<RovenueChangeEvent> get changes => _changesHub.stream;

  /// Broadcast stream of log lines forwarded from the Rust core. Plain
  /// broadcast for the same reason as [changes]: a dropped log line before
  /// a listener attaches has no correctness impact — logging is
  /// best-effort observability, not state the app depends on.
  Stream<RovenueLogRecord> get logs => _logsHub.stream;

  /// Broadcast stream of funnel claims resolved asynchronously on the
  /// native side (e.g. a deferred deep link or clipboard token).
  ///
  /// Unlike [changes]/[logs], this DOES replay the most recent claim to a
  /// new subscriber — implemented in
  /// `rovenue_flutter_platform_interface`'s `MethodChannelRovenue`, whose
  /// native listener starts receiving events at plugin registration,
  /// independent of whether any Dart code has subscribed here yet. A
  /// resolved claim's payload (subscriber id + collected funnel answers)
  /// cannot be reconstructed from any other API once dropped, so — unlike
  /// [changes] — losing one is a real, unrecoverable loss. See
  /// `method_channel_rovenue.dart`'s `_lastFunnelClaim` for the
  /// implementation and `method_channel_test.dart` for the replay test.
  Stream<FunnelClaim> get funnelClaims => _funnelClaimsHub.stream;
}

/// Lazily multiplexes N Dart-side listeners onto exactly one subscription
/// of a platform-interface stream (read via [_source], not cached, so a
/// swapped `RovenuePlatform.instance` — as tests do — is honored the next
/// time the hub goes from zero to one listener).
///
/// Built on [Stream.multi] rather than a plain [StreamController.broadcast]
/// because a broadcast controller's `onListen` fires only on the 0→1
/// listener-count transition — perfect for enforcing "one underlying
/// subscription no matter how many Dart-side listeners attach", but unable
/// to hand a 2nd/3rd *new* listener anything a 1st listener already
/// consumed. [Stream.multi] instead runs its callback once per listener
/// (this is the SDK's own documented pattern for "repeat the latest event
/// to new listeners" — see `dart:async`'s `Stream.multi` doc example),
/// which is exactly what [replay] needs while still sharing one upstream
/// subscription (guarded by `_sourceSubscription ??=` below, evaluating
/// [_source] — i.e. reading `RovenuePlatform.instance` — only on the
/// genuine 0→1 transition of *this hub's own* listener set).
///
/// When [replay] is `true`, the most recent event is cached and replayed
/// (synchronously, via [MultiStreamController.addSync] — an ordinary
/// broadcast stream has no synchronous-delivery hook, which is what made
/// an earlier `async*`-based version of this replay racy) to every NEW
/// listener before it sees live events. This is deliberately a second,
/// independent replay layer on top of `MethodChannelRovenue`'s own
/// `_lastFunnelClaim` replay in the platform-interface package: that layer
/// only rescues an event that fires before this hub has ever subscribed to
/// the platform stream (i.e. before the very first Dart-side listener
/// anywhere); once this hub HAS subscribed, it holds exactly one upstream
/// subscription by design, so without this hub's OWN cache a 2nd/3rd
/// listener attaching after the 1st would still see nothing. Only
/// [Rovenue.funnelClaims] sets `replay: true` — a funnel claim's payload
/// cannot be reconstructed once missed. [Rovenue.changes]/[Rovenue.logs]
/// stay plain (`replay: false`; see their doc comments).
class _StreamHub<T> {
  _StreamHub(this._source, {this.replay = false});

  final Stream<T> Function() _source;
  final bool replay;

  StreamSubscription<T>? _sourceSubscription;
  final Set<MultiStreamController<T>> _listeners = <MultiStreamController<T>>{};
  T? _last;

  Stream<T> get stream => Stream<T>.multi((controller) {
        if (replay) {
          final T? snapshot = _last;
          if (snapshot != null) controller.addSync(snapshot);
        }
        _listeners.add(controller);
        _sourceSubscription ??= _source().listen(_onSourceEvent, onError: _onSourceError);
        controller.onCancel = () {
          _listeners.remove(controller);
          if (_listeners.isEmpty) {
            _sourceSubscription?.cancel();
            _sourceSubscription = null;
          }
        };
      }, isBroadcast: true);

  void _onSourceEvent(T event) {
    if (replay) _last = event;
    for (final controller in List<MultiStreamController<T>>.of(_listeners)) {
      controller.addSync(event);
    }
  }

  void _onSourceError(Object error, StackTrace stackTrace) {
    for (final controller in List<MultiStreamController<T>>.of(_listeners)) {
      controller.addErrorSync(error, stackTrace);
    }
  }
}
