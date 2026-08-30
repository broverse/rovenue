// PaywallViewFactory.kt — registers the native paywall PlatformView
// (Task 7) under view type `dev.rovenue.flutter/paywall_view`. Mirrors
// `PaywallViewFactory.swift`'s structure.

package dev.rovenue.flutter

import android.content.Context
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.StandardMessageCodec
import io.flutter.plugin.platform.PlatformView
import io.flutter.plugin.platform.PlatformViewFactory

internal class PaywallViewFactory(private val messenger: BinaryMessenger) :
    PlatformViewFactory(StandardMessageCodec.INSTANCE) {

    override fun create(context: Context, viewId: Int, args: Any?): PlatformView =
        PaywallPlatformView(context, viewId, args, messenger)
}
