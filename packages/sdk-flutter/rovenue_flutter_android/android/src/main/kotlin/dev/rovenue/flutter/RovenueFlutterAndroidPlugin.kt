// RovenueFlutterAndroidPlugin.kt — plugin entry point registered by the
// Flutter engine (`pluginClass: RovenueFlutterAndroidPlugin` in
// pubspec.yaml).
//
// Wires the generated `RovenueHostApi` (Dart → native calls) to
// `HostApiImpl`, and the generated `RovenueFlutterApi` (native → Dart
// events) to `EventBridge`. No business logic lives here — see
// HostApiImpl.kt / EventBridge.kt / Mapping.kt. Mirrors
// `RovenueFlutterIosPlugin.swift`'s structure.
//
// `ActivityAware` is required because `purchase()`/`restorePurchases()`
// need the current foreground `Activity` to drive Play Billing (see
// `packages/sdk-rn/android/.../RovenueModule.kt`, which obtains one via
// Expo's `appContext.currentActivity`). Here the plugin tracks it itself
// through the standard `ActivityAware` lifecycle and hands `HostApiImpl` a
// lazy accessor rather than a snapshot, so a purchase started while
// rotating (between `onDetachedFromActivityForConfigChanges` and
// `onReattachedToActivityForConfigChanges`) always reads the latest value.

package dev.rovenue.flutter

import android.app.Activity
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

class RovenueFlutterAndroidPlugin : FlutterPlugin, ActivityAware {
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private var eventBridge: EventBridge? = null
    private var hostApi: HostApiImpl? = null
    private var currentActivity: Activity? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        val messenger = binding.binaryMessenger
        val flutterApi = RovenueFlutterApi(messenger)
        val bridge = EventBridge(flutterApi, scope)
        eventBridge = bridge
        val api = HostApiImpl(
            appContext = binding.applicationContext,
            activityProvider = { currentActivity },
            eventBridge = bridge,
            scope = scope,
        )
        hostApi = api
        RovenueHostApi.setUp(messenger, api)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        RovenueHostApi.setUp(binding.binaryMessenger, null)
        eventBridge?.stop()
        eventBridge = null
        hostApi = null
        scope.cancel()
    }

    // ---------------- ActivityAware ----------------

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        currentActivity = binding.activity
    }

    override fun onDetachedFromActivityForConfigChanges() {
        currentActivity = null
    }

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
        currentActivity = binding.activity
    }

    override fun onDetachedFromActivity() {
        currentActivity = null
    }
}
