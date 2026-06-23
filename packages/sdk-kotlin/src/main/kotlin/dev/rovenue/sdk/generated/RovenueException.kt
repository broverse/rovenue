// RovenueException.kt — hand-written wrapper in the generated package.
//
// UniFFI emits RovenueErrorFfi as the raw FFI error type. This sealed class
// sits one level above it and is the type the rest of the SDK (and callers)
// catch at the Kotlin layer. It mirrors the Swift SDK's RovenueError enum.
//
// Variants:
//   InvalidApiKey  — bad/blank API key supplied at configure() time (thrown
//                    before the Rust core is constructed).
//   Generic        — all errors propagated from the Rust core via FFI; wraps
//                    the kind/message/serverCode/httpStatus/retryable fields
//                    from RovenueErrorFfi.Generic.

package dev.rovenue.sdk.generated

sealed class RovenueException(message: String) : Exception(message) {

    /** The API key supplied to configure() was blank or structurally invalid. */
    class InvalidApiKey(message: String) : RovenueException(message)

    /**
     * A typed error propagated from the Rust core via FFI.
     *
     * @param kind         Structured error category (see [ErrorKind]).
     * @param errorMessage Human-readable description.
     * @param serverCode   Optional machine-readable code returned by the server.
     * @param httpStatus   HTTP status code (null for non-HTTP errors).
     * @param isRetryable  Whether the operation may be safely retried.
     */
    class Generic(
        val kind: ErrorKind,
        val errorMessage: String,
        val serverCode: String?,
        val httpStatus: Int?,
        val isRetryable: Boolean,
    ) : RovenueException(errorMessage)

    companion object {
        /**
         * Lift a raw [RovenueErrorFfi] from the generated bindings into the
         * public [RovenueException] hierarchy. Called at every FFI boundary that
         * propagates a Rust error.
         */
        fun from(ffi: RovenueErrorFfi): RovenueException = when (ffi) {
            is RovenueErrorFfi.Generic -> Generic(
                kind = ffi.kind,
                errorMessage = ffi.errorMessage,
                serverCode = ffi.serverCode,
                httpStatus = ffi.httpStatus?.toInt(),
                isRetryable = ffi.retryable,
            )
        }
    }
}
