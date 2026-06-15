package dev.rovenue.sdk.internal

import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner

/**
 * Fires [onForeground] each time the app process enters the foreground
 * (`ON_START`). Registered against `ProcessLifecycleOwner` by [dev.rovenue.sdk.Rovenue].
 */
internal class ForegroundReconcileObserver(
    private val onForeground: () -> Unit,
) : DefaultLifecycleObserver {
    override fun onStart(owner: LifecycleOwner) {
        onForeground()
    }
}
