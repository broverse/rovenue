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

  /// Initialize the SDK. Must be called before any other method here —
  /// everything else assumes a configured native core and crashes
  /// (`fatalError` on iOS, `IllegalStateException` on Android) otherwise.
  /// Calling it again replaces the underlying native instance (the
  /// equivalent of calling [shutdown] first). `appVersion` is optional;
  /// when omitted, the native layer auto-reads the host app's version and
  /// [getAppVersion] reports back whatever was actually resolved.
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

  /// Stop the native core's background polling (entitlements/remote
  /// config). Most apps never need this directly — [configure] already
  /// tears down and replaces the previous instance when called again.
  Future<void> shutdown() => _platform.shutdown();

  /// Tell the native core whether the host app is foregrounded, gating
  /// background polling and triggering an immediate drain of the queued
  /// paywall-event queue on the foreground transition. Wire this to
  /// `AppLifecycleState` changes (`WidgetsBindingObserver`).
  Future<void> setForeground(bool foreground) => _platform.setForeground(foreground);

  /// The native SDK's own semantic version, for diagnostics — not this
  /// Dart package's `pubspec.yaml` version and not network-derived.
  Future<String> getVersion() => _platform.getVersion();

  /// The host app version [configure] resolved: the explicit `appVersion`
  /// argument when one was given, otherwise whatever the native layer
  /// auto-read from the platform package manager/bundle. `null` before
  /// [configure] has run.
  Future<String?> getAppVersion() => _platform.getAppVersion();

  // ---------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------

  /// Current identity — the anonymous `rovenueId` plus `appUserId` once
  /// [identify] has been called. A local read; does not hit the network.
  Future<RovenueUser> currentUser() => _platform.currentUser();

  /// Link the anonymous device identity to [appUserId]. The local write
  /// always succeeds and fires an `onChange` event; the server-side
  /// `POST /v1/identify` is best-effort — a failure (offline/5xx) is
  /// retried automatically later, not surfaced as an error here. Throws
  /// [RovenueException] only on validation failure (e.g. a blank id).
  Future<void> identify(String appUserId) => _platform.identify(appUserId);

  /// Log out the current user: mints a fresh anonymous `rovenueId`, drops
  /// `appUserId`, and clears scope-bound local state (buffered session
  /// events, attributes, the Apple app-account token) so the next
  /// identity starts clean. Client-local only — does not contact the
  /// server.
  Future<void> logOut() => _platform.logOut();

  // ---------------------------------------------------------------------
  // Entitlements
  // ---------------------------------------------------------------------

  /// Look up one entitlement by id from the local cache — resolves from
  /// disk/memory, not a network round trip. `null` when the id is unknown
  /// or not currently granted. A stale cache triggers a background
  /// refresh natively; never call [refreshEntitlements] from an `onChange`
  /// listener reacting to that refresh's own event, or it loops.
  Future<Entitlement?> entitlement(String id) => _platform.entitlement(id);

  /// All currently-granted entitlements from the local cache — a cache
  /// read, not a network call. Same background staleness-refresh
  /// behaviour and `onChange` re-entrancy footgun as [entitlement].
  Future<List<Entitlement>> entitlementsAll() => _platform.entitlementsAll();

  /// Force a network refresh of entitlements, bypassing the staleness
  /// window [entitlement]/[entitlementsAll] use. Never call this from
  /// inside an `onChange` listener triggered by entitlements changing —
  /// the refresh re-emits that same event, re-invoking the listener,
  /// forever.
  Future<void> refreshEntitlements() => _platform.refreshEntitlements();

  // ---------------------------------------------------------------------
  // Virtual currencies
  // ---------------------------------------------------------------------

  /// All virtual-currency balances, keyed by currency code, from the local
  /// cache — a cache read, not a network call. Stale balances trigger a
  /// background refresh natively; never call [refreshVirtualCurrencies]
  /// from an `onChange` listener reacting to that refresh's own event.
  Future<Map<String, int>> virtualCurrencies() => _platform.virtualCurrencies();

  /// One virtual-currency balance by code from the local cache (`0` when
  /// the code is unknown — never an error). Same cache-read and
  /// re-entrancy footgun as [virtualCurrencies].
  Future<int> virtualCurrency(String code) => _platform.virtualCurrency(code);

  /// Force a network refresh of virtual-currency balances, bypassing the
  /// staleness window [virtualCurrencies]/[virtualCurrency] use. Never
  /// call this from inside the balance-changed listener it fires — that
  /// re-triggers the listener, forever.
  Future<void> refreshVirtualCurrencies() => _platform.refreshVirtualCurrencies();

  // ---------------------------------------------------------------------
  // Purchases / placements
  // ---------------------------------------------------------------------

  /// Fetch the project's current offerings from the backend. A network
  /// call from the app's perspective; the native/Rust layer falls back to
  /// its own last-cached response on a connectivity failure, but an
  /// auth/server rejection still throws [RovenueException].
  Future<Offerings> getOfferings() => _platform.getOfferings();

  /// Resolve a placement into the paywall (drawing an experiment variant
  /// when applicable) the caller should render. `null` means the
  /// placement resolved to nothing — NOT an error; render no paywall in
  /// that case. On success, the paywall's attribution snapshot is stamped
  /// natively so the next purchase's receipt POST carries it.
  Future<Paywall?> getPaywall(String placementIdentifier, {String? locale}) =>
      _platform.getPaywall(placementIdentifier, locale: locale);

  /// Load a bundled fallback-placements file (once, replacing any
  /// previously-loaded set) so [getPaywall] can serve placements offline
  /// when both network and disk cache miss. Returns the count of entries
  /// actually loaded; a malformed file throws [RovenueException]
  /// (`RovenueErrorKind.invalidArgument`).
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

  /// Restore the user's previously-purchased entitlements from the store
  /// (StoreKit's transaction history / Google Play's owned-purchases
  /// query), re-submitting any found receipts so the server can
  /// (re-)grant entitlements for this subscriber. Use for the "Restore
  /// Purchases" button required by App Store review — entitlements are
  /// already synced automatically via [configure]/purchase receipt
  /// posting, so this isn't needed on every launch.
  Future<PurchaseResult> restorePurchases() => _platform.restorePurchases();

  // ---------------------------------------------------------------------
  // Remote Config
  // ---------------------------------------------------------------------

  /// Force an immediate Remote Config fetch from the server, bypassing the
  /// staleness window the getters below use. Never call this from inside
  /// a remote-config-changed `onChange` listener it triggers, or it loops.
  Future<void> refreshRemoteConfig() => _platform.refreshRemoteConfig();

  /// Boolean feature-flag value for [key] from the local cache, or
  /// [fallback] when absent/mistyped. Cache read, never blocks on
  /// network; a stale cache triggers a background refresh, so never call
  /// [refreshRemoteConfig] from a remote-config-changed listener this can
  /// trigger.
  Future<bool> remoteConfigBool(String key, bool fallback) => _platform.remoteConfigBool(key, fallback);

  /// String feature-flag value for [key] from the local cache, or
  /// [fallback] when absent/mistyped. Same cache-read and background
  /// staleness-refresh behaviour as [remoteConfigBool].
  Future<String> remoteConfigString(String key, String fallback) =>
      _platform.remoteConfigString(key, fallback);

  /// Integer feature-flag value for [key] from the local cache, or
  /// [fallback] when absent/mistyped. Same cache-read and background
  /// staleness-refresh behaviour as [remoteConfigBool].
  Future<int> remoteConfigInt(String key, int fallback) => _platform.remoteConfigInt(key, fallback);

  /// Floating-point feature-flag value for [key] from the local cache, or
  /// [fallback] when absent/mistyped. Same cache-read and background
  /// staleness-refresh behaviour as [remoteConfigBool].
  Future<double> remoteConfigDouble(String key, double fallback) =>
      _platform.remoteConfigDouble(key, fallback);

  /// Raw JSON string for any present flag (object/array/primitive), or
  /// `null` when [key] is absent. Use this for structured flag values the
  /// typed getters above can't represent; parse it yourself.
  Future<String?> remoteConfigJson(String key) => _platform.remoteConfigJson(key);

  /// All feature-flag keys currently present in the local remote-config
  /// cache. Cache read; triggers the same background staleness refresh as
  /// the typed getters above.
  Future<List<String>> remoteConfigKeys() => _platform.remoteConfigKeys();

  /// The whole Remote Config payload (`{ flags, experiments }`) as a JSON
  /// string, for callers backing their own reactive/synchronous read
  /// layer instead of calling the typed getters one key at a time.
  Future<String> remoteConfigAllJson() => _platform.remoteConfigAllJson();

  /// This subscriber's variant assignment for experiment [key], or `null`
  /// when not enrolled. Unlike the flag getters, a non-`null` result also
  /// records an exposure (best-effort, deduped) for experiment analysis —
  /// call this only where the variant assignment actually drives what the
  /// user sees, not speculatively, or exposure counts get inflated.
  Future<ExperimentAssignment?> experiment(String key) => _platform.experiment(key);

  /// Every experiment this subscriber is currently enrolled in. Unlike
  /// [experiment], this does NOT record exposures — a plain cache read
  /// for callers that need the full set (e.g. debug UI) without treating
  /// enumeration as "shown to the user".
  Future<List<ExperimentAssignment>> experimentsAll() => _platform.experimentsAll();

  // ---------------------------------------------------------------------
  // Refund Shield
  // ---------------------------------------------------------------------

  /// Return the current identity scope's Apple `appAccountToken` (a
  /// UUID), creating and persisting one on first call. Pass this to
  /// StoreKit's purchase options so the resulting transaction carries the
  /// token Apple echoes back — the anchor the receipt/server-to-server
  /// notification path uses to bind the transaction to this subscriber.
  /// `logOut` clears it, so a new anonymous scope gets its own token.
  Future<String> getAppAccountToken() => _platform.getAppAccountToken();

  /// Append one session-lifecycle event ([SessionEventKind.open] /
  /// `.background` / `.close`) to the local buffer for later
  /// at-least-once delivery — does not itself hit the network.
  /// [durationMs] is only meaningful for `.close` (foreground session
  /// length); leave it `null` for `.open`/`.background`.
  Future<void> recordSessionEvent(
    SessionEventKind kind,
    String occurredAt, {
    int? durationMs,
  }) =>
      _platform.recordSessionEvent(kind, occurredAt, durationMs: durationMs);

  /// Force an immediate POST of buffered session events, bypassing the
  /// dispatcher's own tick. Returns the number actually sent. Buffered
  /// events already survive a process kill, so this is for callers that
  /// want the flush to happen now rather than on the next automatic tick.
  Future<int> flushSessionEvents() => _platform.flushSessionEvents();

  // ---------------------------------------------------------------------
  // Funnel attribution
  // ---------------------------------------------------------------------

  /// Claim a known funnel token (from a deep link, QR code, or referral
  /// code) and resolve it to a subscriber + funnel-answer payload
  /// server-side. On success, refreshes entitlements and also emits on
  /// [funnelClaims]. Throws [RovenueException] with
  /// `RovenueErrorKind.funnelTokenNotFound` / `.funnelTokenExpired` /
  /// `.funnelTokenAlreadyClaimed` for the corresponding server rejections.
  Future<FunnelClaim> claimFunnelToken(String token) => _platform.claimFunnelToken(token);

  /// Recover a token via the install-attribution endpoint (Android's Play
  /// Install Referrer, or an equivalent server-side match) then claim it.
  /// Resolves `null` when no unattributed install matches a pending
  /// funnel token — that's the common case, not an error.
  Future<FunnelClaim?> claimInstall([ClaimInstallParams params = const ClaimInstallParams()]) =>
      _platform.claimInstall(params);

  /// Kick off the email magic-link funnel-claim path. Resolution completes
  /// later when the link returns to the app (deep link → this resolves via
  /// [claimFromUrl]/[funnelClaims], not via this call's own return value).
  Future<void> claimViaEmail(String email) => _platform.claimViaEmail(email);

  /// Reads a funnel token out of the system clipboard and claims it.
  ///
  /// **iOS only.** On Android this always resolves `null` without touching
  /// the clipboard: Android's deferred-attribution path is the Play Install
  /// Referrer, which [claimInstall] reads. Call both if you support both
  /// platforms — this one is a no-op on Android by design, not a bug.
  Future<FunnelClaim?> claimFromClipboard() => _platform.claimFromClipboard();

  /// Persisted per-install id (`inst_<cuid2>`), generated on first access.
  /// A local read; does not hit the network.
  Future<String> installId() => _platform.installId();

  /// Whether this install has already successfully claimed a funnel token.
  /// A synchronous-feeling local read of persisted install state — does
  /// not hit the network. Use it to gate first-launch attribution
  /// orchestration so [claimFunnelToken]/[claimInstall]/[claimViaEmail]/
  /// [claimFromClipboard]/[claimFromUrl] only run once per install, even
  /// across app restarts.
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

  /// Emit a generic event (fire-and-forget, retried a few times
  /// internally). [envelopeJson] is the camelCase wire envelope; when it
  /// omits `subscriberId`, the native layer fills it from the current
  /// identity scope.
  Future<void> track(String envelopeJson) => _platform.track(envelopeJson);

  /// Enqueue a `paywall_view`/`paywall_close` event into the durable,
  /// process-kill-safe queue instead of posting inline like [track] does.
  /// Most apps never call this directly — the built-in paywall renderer
  /// emits it automatically; use it only when rendering a custom paywall
  /// UI yourself.
  Future<void> enqueuePaywallEvent(String envelopeJson) => _platform.enqueuePaywallEvent(envelopeJson);

  // ---------------------------------------------------------------------
  // Subscriber attributes
  // ---------------------------------------------------------------------

  /// Queue a batch of subscriber-attribute mutations. Written to the
  /// local buffer immediately; the server sync happens in the background
  /// (periodic tick, on foreground, or via [flushAttributes]). A `null`
  /// value deletes the key. Reserved keys (prefixed with `$`, e.g.
  /// `$email`) map to first-class fields server-side — [setEmail]/
  /// [setDisplayName]/[setPhoneNumber]/[setPushToken] are thin wrappers
  /// over this for the common ones.
  Future<void> setAttributes(Map<String, String?> attributes) => _platform.setAttributes(attributes);

  /// Subscriber's email → the `$email` reserved attribute. Same
  /// buffered-write, background-flush contract as [setAttributes]; `null`
  /// clears it.
  Future<void> setEmail(String? email) => _platform.setEmail(email);

  /// Subscriber's display name → the `$displayName` reserved attribute.
  /// Same buffered-write, background-flush contract as [setAttributes];
  /// `null` clears it.
  Future<void> setDisplayName(String? name) => _platform.setDisplayName(name);

  /// Subscriber's phone number → the `$phoneNumber` reserved attribute.
  /// Same buffered-write, background-flush contract as [setAttributes];
  /// `null` clears it.
  Future<void> setPhoneNumber(String? phone) => _platform.setPhoneNumber(phone);

  /// Device push token → the platform's reserved attribute (`$apnsTokens`
  /// on iOS, `$fcmTokens` on Android — the native layer picks the right
  /// key). Same buffered-write, background-flush contract as
  /// [setAttributes]; `null` clears it.
  Future<void> setPushToken(String? token) => _platform.setPushToken(token);

  /// Force an immediate flush of buffered attribute mutations to the
  /// server, bypassing the background tick. Returns the number of
  /// mutations actually sent. Most apps never need this — the background
  /// dispatcher already flushes on its own tick and on foreground.
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
