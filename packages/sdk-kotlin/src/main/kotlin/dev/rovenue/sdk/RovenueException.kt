// RovenueException.kt — single public exception type for all Rovenue errors.
//
// This class is the public surface that callers catch. It wraps the generated
// RovenueErrorFfi.Generic from the Rust core FFI boundary, mapping UShort? to
// Int? for idiomatic Kotlin.
//
// Purchase-store failures (cancelled, deferred, not-found, already-owned,
// payment-declined, service-unavailable, ineligible, store-problem) use this
// same type with the appropriate ErrorKind variant, so callers handle all
// errors in one catch block.

package dev.rovenue.sdk

import dev.rovenue.sdk.generated.ErrorKind
import dev.rovenue.sdk.generated.RovenueErrorFfi

/**
 * The single public exception thrown by all Rovenue SDK operations.
 *
 * @param kind         Structured error category — use this for programmatic handling.
 * @param message      Human-readable description (also the [Exception.message]).
 * @param serverCode   Optional machine-readable code returned by the server.
 * @param httpStatus   HTTP status code, or null for non-HTTP errors.
 * @param isRetryable  Whether the caller may safely retry the operation.
 */
class RovenueException(
    val kind: ErrorKind,
    override val message: String,
    val serverCode: String? = null,
    val httpStatus: Int? = null,
    val isRetryable: Boolean = false,
) : Exception(message) {

    companion object {
        /** Lift a [RovenueErrorFfi.Generic] from the FFI boundary. */
        internal fun from(ffi: RovenueErrorFfi.Generic): RovenueException = RovenueException(
            kind = ffi.kind,
            message = ffi.detail,
            serverCode = ffi.serverCode,
            httpStatus = ffi.httpStatus?.toInt(),
            isRetryable = ffi.retryable,
        )
    }
}
