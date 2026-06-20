// FunnelClaimBridge.kt — multicast between the Rust FunnelClaimListener
// callback and Kotlin coroutine consumers.
//
// Rust core's registerFunnelClaimListener(listener) accepts exactly one
// FunnelClaimListener at a time (per FFI design). The FunnelClaimBridge
// is the single registered listener; it fans out every resolved claim
// into a MutableSharedFlow that arbitrary Kotlin code can `.collect {}`
// from.
//
// Mirrors ObserverBridge exactly — payload is FunnelClaimResult instead
// of ChangeEvent.

package dev.rovenue.sdk.internal

import dev.rovenue.sdk.generated.FunnelClaimListener
import dev.rovenue.sdk.generated.FunnelClaimResult
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/** Single registered FunnelClaimListener fanning resolved claims into a
 *  SharedFlow — mirrors ObserverBridge. */
internal class FunnelClaimBridge : FunnelClaimListener {
    private val _flow = MutableSharedFlow<FunnelClaimResult>(
        replay = 0,
        extraBufferCapacity = 16,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    /** Called by UniFFI on the Rust listener thread.
     *
     *  tryEmit is non-suspending and returns false only when the buffer is
     *  full and DROP_OLDEST drops one — we silently accept the drop here.
     *  Callers should re-query server state if they miss an event. */
    override fun onFunnelClaimResolved(result: FunnelClaimResult) {
        _flow.tryEmit(result)
    }

    val flow: SharedFlow<FunnelClaimResult> = _flow.asSharedFlow()
}
