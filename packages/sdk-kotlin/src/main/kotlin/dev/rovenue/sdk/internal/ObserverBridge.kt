// ObserverBridge.kt — multicast between the Rust observer callback and
// Kotlin coroutine consumers.
//
// Rust core's register_observer(obs) accepts exactly one Observer at a
// time (per FFI design). The ObserverBridge is the single registered
// Observer; it fans out every `onChange` into a MutableSharedFlow that
// arbitrary Kotlin code can `.collect { }` from.
//
// SharedFlow vs the Swift AsyncStream approach: SharedFlow handles
// multicast natively (no UUID-keyed table), and its bounded buffer +
// onBufferOverflow policy give us backpressure without manual
// bookkeeping.

package dev.rovenue.sdk.internal

import dev.rovenue.sdk.generated.ChangeEvent
import dev.rovenue.sdk.generated.Observer
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

internal class ObserverBridge : Observer {
    private val _flow = MutableSharedFlow<ChangeEvent>(
        replay = 0,
        extraBufferCapacity = 64,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    /** Called by UniFFI on the Rust observer thread.
     *
     *  tryEmit is non-suspending and returns false only when the buffer is
     *  full and DROP_OLDEST drops one — we silently accept the drop here.
     *  Events are advisory cache-change hints; reading current state via
     *  the cache-first methods is always authoritative. */
    override fun onChange(event: ChangeEvent) {
        _flow.tryEmit(event)
    }

    val flow: SharedFlow<ChangeEvent> = _flow.asSharedFlow()
}
