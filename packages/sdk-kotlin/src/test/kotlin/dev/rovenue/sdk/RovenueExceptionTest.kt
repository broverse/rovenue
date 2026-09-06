// RovenueExceptionTest.kt — pins RovenueException.from(RovenueErrorFfi.Generic)
// tolerance for a server error `code` this package's release predates.
//
// Context: RovenueException.from() never switches on the raw wire `code`
// string — that string only ever reaches this layer as opaque `serverCode`
// metadata. The single place a wire code participates in *kind* selection is
// Rust core's `error_from_status` (packages/core-rs/src/transport/http_client.rs),
// which keys purely off HTTP status (401/402/403/404/409/422|400/429/4xx/5xx/_)
// and is exhaustive — see `preserves_backend_code_and_message` in
// packages/core-rs/tests/error_mapping.rs, which already exercises an
// unrecognized code ("BYOK_NOT_ALLOWED") without incident. `ErrorKind` itself
// is a closed UniFFI-generated enum, so `RovenueException.from` can never
// receive an "unknown kind" value to begin with — a genuinely new server
// `code` string can only ever arrive here as an unfamiliar `serverCode` on an
// otherwise-ordinary, already-known `ErrorKind`.
//
// This test proves that path: an arbitrary/never-seen serverCode is carried
// through unchanged, without throwing or corrupting the mapped kind.

package dev.rovenue.sdk

import dev.rovenue.sdk.generated.ErrorKind
import dev.rovenue.sdk.generated.RovenueErrorFfi
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

class RovenueExceptionTest {

    @Test
    fun `from carries an unrecognized serverCode through opaquely without throwing`() {
        // "BEARER_REQUIRED" is one of the four codes Task 5 is about to start
        // emitting on the wire for the first time; this package's generated
        // bindings were built before that change, so it is — from this
        // layer's point of view — an unrecognized string.
        val ffi = RovenueErrorFfi.Generic(
            kind = ErrorKind.INVALID_API_KEY,
            detail = "missing bearer token",
            serverCode = "BEARER_REQUIRED",
            httpStatus = 401.toUShort(),
            retryable = false,
        )

        val ex = RovenueException.from(ffi)

        assertEquals(ErrorKind.INVALID_API_KEY, ex.kind)
        assertEquals("BEARER_REQUIRED", ex.serverCode)
        assertEquals("missing bearer token", ex.message)
        assertEquals(401, ex.httpStatus)
        assertFalse(ex.isRetryable)
    }

    @Test
    fun `from carries a wholly novel serverCode string without altering kind`() {
        val ffi = RovenueErrorFfi.Generic(
            kind = ErrorKind.FORBIDDEN,
            detail = "wrong key kind",
            serverCode = "SOME_CODE_THIS_RELEASE_HAS_NEVER_SEEN",
            httpStatus = 403.toUShort(),
            retryable = false,
        )

        val ex = RovenueException.from(ffi)

        assertEquals(ErrorKind.FORBIDDEN, ex.kind)
        assertEquals("SOME_CODE_THIS_RELEASE_HAS_NEVER_SEEN", ex.serverCode)
    }
}
