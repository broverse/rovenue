package dev.rovenue.sdk.internal

import android.content.Context
import android.content.res.AssetManager
import io.mockk.every
import io.mockk.mockk
import org.junit.jupiter.api.Test
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Covers the only logic `setFallbackPlacements(context, assetPath)` adds
 * over the `json:` overload it delegates to: opening the asset, decoding it
 * as UTF-8, and closing the stream. Previously untested (whole-phase review
 * follow-up) because the overload's body was inline and needed a live core
 * to reach.
 */
class AssetReaderTest {

    /** Records whether `close()` ran — ByteArrayInputStream's is a no-op. */
    private class RecordingStream(bytes: ByteArray) : InputStream() {
        private val delegate = ByteArrayInputStream(bytes)
        var closed = false
            private set

        override fun read(): Int = delegate.read()
        override fun read(b: ByteArray, off: Int, len: Int): Int = delegate.read(b, off, len)
        override fun close() {
            closed = true
            delegate.close()
        }
    }

    private fun contextReturning(stream: InputStream, path: String = "rovenue-fallback.json"): Context {
        val assets = mockk<AssetManager>()
        every { assets.open(path) } returns stream
        val context = mockk<Context>()
        every { context.assets } returns assets
        return context
    }

    @Test
    fun `reads the asset and decodes it as UTF-8`() {
        // Non-ASCII on purpose: proves decodeToString, not a byte-wise cast.
        val json = """{"formatVersion":1,"placements":{"onboarding":{"name":"Pro'ya geç"}}}"""
        val context = contextReturning(RecordingStream(json.toByteArray(Charsets.UTF_8)))

        assertEquals(json, readAssetText(context, "rovenue-fallback.json"))
    }

    @Test
    fun `closes the stream after reading`() {
        val stream = RecordingStream("{}".toByteArray())
        readAssetText(contextReturning(stream), "rovenue-fallback.json")
        assertTrue(stream.closed, "asset stream must be closed")
    }

    @Test
    fun `propagates an IOException from a missing asset`() {
        val assets = mockk<AssetManager>()
        every { assets.open("missing.json") } throws IOException("asset not found")
        val context = mockk<Context>()
        every { context.assets } returns assets

        assertFailsWith<IOException> { readAssetText(context, "missing.json") }
    }
}
