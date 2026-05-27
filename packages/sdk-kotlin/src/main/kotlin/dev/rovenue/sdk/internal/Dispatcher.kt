// Dispatcher.kt — bridges blocking Rust-core calls into Kotlin suspend fun.
//
// The Rust core (per the UniFFI bindings we generate in M1) is fully
// synchronous. Calling it from the caller's coroutine context would block
// the dispatcher thread. We off-load to Dispatchers.IO, which is the
// canonical "blocking work on a thread pool" dispatcher in coroutines.
//
// Unlike the Swift façade we don't need a serial queue — the Rust core's
// own Arc<Mutex<...>> already serializes concurrent calls per-instance.
// Dispatchers.IO is a bounded thread pool (64 threads by default) optimal
// for blocking I/O.

package dev.rovenue.sdk.internal

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal class Dispatcher {
    suspend fun <T> run(block: () -> T): T = withContext(Dispatchers.IO) {
        block()
    }
}
