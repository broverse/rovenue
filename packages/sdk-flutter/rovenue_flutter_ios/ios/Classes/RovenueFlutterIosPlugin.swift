// RovenueFlutterIosPlugin.swift — plugin entry point registered by the
// Flutter engine (`pluginClass: RovenueFlutterIosPlugin` in pubspec.yaml).
//
// Wires the generated `RovenueHostApi` (Dart → native calls) to
// `HostApiImpl`, and the generated `RovenueFlutterApi` (native → Dart
// events) to `EventBridge`. No business logic lives here — see
// HostApiImpl.swift / EventBridge.swift / Mapping.swift.

import Foundation
#if os(iOS)
  import Flutter
#elseif os(macOS)
  import FlutterMacOS
#else
  #error("Unsupported platform.")
#endif
import Rovenue

public class RovenueFlutterIosPlugin: NSObject, FlutterPlugin {
  private let eventBridge: EventBridge
  private let hostApi: HostApiImpl

  public static func register(with registrar: FlutterPluginRegistrar) {
    #if os(iOS)
      let messenger = registrar.messenger()
    #else
      let messenger = registrar.messenger
    #endif
    let flutterApi = RovenueFlutterApi(binaryMessenger: messenger)
    let instance = RovenueFlutterIosPlugin(flutterApi: flutterApi)
    RovenueHostApiSetup.setUp(binaryMessenger: messenger, api: instance.hostApi)
  }

  init(flutterApi: RovenueFlutterApiProtocol) {
    self.eventBridge = EventBridge(flutterApi: flutterApi)
    self.hostApi = HostApiImpl(eventBridge: eventBridge)
    super.init()
  }
}
