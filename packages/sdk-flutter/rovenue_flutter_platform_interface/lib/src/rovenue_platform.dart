import 'package:plugin_platform_interface/plugin_platform_interface.dart';

import 'method_channel_rovenue.dart';
import 'models.dart';

/// The platform interface implemented by `rovenue_flutter_ios` and
/// `rovenue_flutter_android`.
///
/// Every member here mirrors one entry of `RovenueHostApi`
/// (`pigeons/rovenue_api.dart`) — same name, same order, minus the two
/// Expo-only bookkeeping hooks that have no Flutter equivalent — plus three
/// broadcast streams mirroring `RovenueFlutterApi`'s native-to-Dart
/// callbacks. Parameters and return types are the PUBLIC models in
/// `models.dart`; the generated Pigeon `Rv*` DTOs never appear here.
///
/// The default [instance] is [MethodChannelRovenue]. Platform packages (or
/// tests) override it via the [instance] setter, which enforces —
/// via [PlatformInterface.verifyToken] — that only subclasses of this class
/// constructed with the shared [_token] may become the active instance.
abstract class RovenuePlatform extends PlatformInterface {
  RovenuePlatform() : super(token: _token);

  static final Object _token = Object();

  static RovenuePlatform _instance = MethodChannelRovenue();

  /// The currently active platform implementation.
  static RovenuePlatform get instance => _instance;

  static set instance(RovenuePlatform instance) {
    PlatformInterface.verifyToken(instance, _token);
    _instance = instance;
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  Future<void> configure({
    required String apiKey,
    String? baseUrl,
    RovenueLogLevel logLevel = RovenueLogLevel.off,
    String? appVersion,
    String? environment,
  }) {
    throw UnimplementedError('configure() has not been implemented.');
  }

  Future<void> shutdown() {
    throw UnimplementedError('shutdown() has not been implemented.');
  }

  Future<void> setForeground(bool foreground) {
    throw UnimplementedError('setForeground() has not been implemented.');
  }

  Future<String> getVersion() {
    throw UnimplementedError('getVersion() has not been implemented.');
  }

  Future<String?> getAppVersion() {
    throw UnimplementedError('getAppVersion() has not been implemented.');
  }

  // ---------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------

  Future<RovenueUser> currentUser() {
    throw UnimplementedError('currentUser() has not been implemented.');
  }

  Future<void> identify(String appUserId) {
    throw UnimplementedError('identify() has not been implemented.');
  }

  Future<void> logOut() {
    throw UnimplementedError('logOut() has not been implemented.');
  }

  // ---------------------------------------------------------------------
  // Entitlements
  // ---------------------------------------------------------------------

  Future<Entitlement?> entitlement(String id) {
    throw UnimplementedError('entitlement() has not been implemented.');
  }

  Future<List<Entitlement>> entitlementsAll() {
    throw UnimplementedError('entitlementsAll() has not been implemented.');
  }

  Future<void> refreshEntitlements() {
    throw UnimplementedError('refreshEntitlements() has not been implemented.');
  }

  // ---------------------------------------------------------------------
  // Virtual currencies
  // ---------------------------------------------------------------------

  Future<Map<String, int>> virtualCurrencies() {
    throw UnimplementedError('virtualCurrencies() has not been implemented.');
  }

  Future<int> virtualCurrency(String code) {
    throw UnimplementedError('virtualCurrency() has not been implemented.');
  }

  Future<void> refreshVirtualCurrencies() {
    throw UnimplementedError('refreshVirtualCurrencies() has not been implemented.');
  }

  // ---------------------------------------------------------------------
  // Purchases / placements
  // ---------------------------------------------------------------------

  Future<Offerings> getOfferings() {
    throw UnimplementedError('getOfferings() has not been implemented.');
  }

  Future<Paywall?> getPaywall(String placementId, {String? locale}) {
    throw UnimplementedError('getPaywall() has not been implemented.');
  }

  Future<int> setFallbackPlacements(String json) {
    throw UnimplementedError('setFallbackPlacements() has not been implemented.');
  }

  Future<PurchaseResult> purchase(
    String productId,
    ProductType productType, {
    String? promotionalOfferId,
    String? basePlanId,
    String? offerId,
  }) {
    throw UnimplementedError('purchase() has not been implemented.');
  }

  Future<PurchaseResult> restorePurchases() {
    throw UnimplementedError('restorePurchases() has not been implemented.');
  }

  // ---------------------------------------------------------------------
  // Remote Config
  // ---------------------------------------------------------------------

  Future<void> refreshRemoteConfig() {
    throw UnimplementedError('refreshRemoteConfig() has not been implemented.');
  }

  Future<bool> remoteConfigBool(String key, bool fallback) {
    throw UnimplementedError('remoteConfigBool() has not been implemented.');
  }

  Future<String> remoteConfigString(String key, String fallback) {
    throw UnimplementedError('remoteConfigString() has not been implemented.');
  }

  Future<int> remoteConfigInt(String key, int fallback) {
    throw UnimplementedError('remoteConfigInt() has not been implemented.');
  }

  Future<double> remoteConfigDouble(String key, double fallback) {
    throw UnimplementedError('remoteConfigDouble() has not been implemented.');
  }

  Future<String?> remoteConfigJson(String key) {
    throw UnimplementedError('remoteConfigJson() has not been implemented.');
  }

  Future<List<String>> remoteConfigKeys() {
    throw UnimplementedError('remoteConfigKeys() has not been implemented.');
  }

  Future<String> remoteConfigAllJson() {
    throw UnimplementedError('remoteConfigAllJson() has not been implemented.');
  }

  Future<ExperimentAssignment?> experiment(String key) {
    throw UnimplementedError('experiment() has not been implemented.');
  }

  Future<List<ExperimentAssignment>> experimentsAll() {
    throw UnimplementedError('experimentsAll() has not been implemented.');
  }

  // ---------------------------------------------------------------------
  // Refund Shield
  // ---------------------------------------------------------------------

  Future<String> getAppAccountToken() {
    throw UnimplementedError('getAppAccountToken() has not been implemented.');
  }

  Future<void> recordSessionEvent(
    SessionEventKind kind,
    String occurredAt, {
    int? durationMs,
  }) {
    throw UnimplementedError('recordSessionEvent() has not been implemented.');
  }

  Future<int> flushSessionEvents() {
    throw UnimplementedError('flushSessionEvents() has not been implemented.');
  }

  // ---------------------------------------------------------------------
  // Funnel attribution
  // ---------------------------------------------------------------------

  Future<FunnelClaim> claimFunnelToken(String token) {
    throw UnimplementedError('claimFunnelToken() has not been implemented.');
  }

  Future<FunnelClaim?> claimInstall(ClaimInstallParams params) {
    throw UnimplementedError('claimInstall() has not been implemented.');
  }

  Future<void> claimViaEmail(String email) {
    throw UnimplementedError('claimViaEmail() has not been implemented.');
  }

  Future<FunnelClaim?> claimFromClipboard() {
    throw UnimplementedError('claimFromClipboard() has not been implemented.');
  }

  Future<String> installId() {
    throw UnimplementedError('installId() has not been implemented.');
  }

  Future<bool> hasResolvedFunnelClaim() {
    throw UnimplementedError('hasResolvedFunnelClaim() has not been implemented.');
  }

  // ---------------------------------------------------------------------
  // Generic events
  // ---------------------------------------------------------------------

  Future<void> track(String envelopeJson) {
    throw UnimplementedError('track() has not been implemented.');
  }

  Future<void> enqueuePaywallEvent(String envelopeJson) {
    throw UnimplementedError('enqueuePaywallEvent() has not been implemented.');
  }

  // ---------------------------------------------------------------------
  // Subscriber attributes
  // ---------------------------------------------------------------------

  Future<void> setAttributes(Map<String, String?> attributes) {
    throw UnimplementedError('setAttributes() has not been implemented.');
  }

  Future<void> setEmail(String? email) {
    throw UnimplementedError('setEmail() has not been implemented.');
  }

  Future<void> setDisplayName(String? name) {
    throw UnimplementedError('setDisplayName() has not been implemented.');
  }

  Future<void> setPhoneNumber(String? phone) {
    throw UnimplementedError('setPhoneNumber() has not been implemented.');
  }

  Future<void> setPushToken(String? token) {
    throw UnimplementedError('setPushToken() has not been implemented.');
  }

  Future<int> flushAttributes() {
    throw UnimplementedError('flushAttributes() has not been implemented.');
  }

  // ---------------------------------------------------------------------
  // Native -> Dart events (mirrors RovenueFlutterApi)
  // ---------------------------------------------------------------------

  /// Broadcast stream of `onChange` events: something the SDK's local cache
  /// changed and the app should re-read it (entitlements, identity,
  /// virtual currencies, or remote config).
  Stream<RovenueChangeEvent> get changes {
    throw UnimplementedError('changes has not been implemented.');
  }

  /// Broadcast stream of log lines forwarded from the Rust core.
  Stream<RovenueLogRecord> get logs {
    throw UnimplementedError('logs has not been implemented.');
  }

  /// Broadcast stream of funnel claims resolved asynchronously on the
  /// native side (e.g. a deferred deep link or clipboard token).
  Stream<FunnelClaim> get funnelClaims {
    throw UnimplementedError('funnelClaims has not been implemented.');
  }
}
