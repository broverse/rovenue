package dev.rovenue.sdk.paywallui

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * [BitmapLruCache] is generic over its value type, and takes its sizing
 * function as a parameter, ONLY so these JVM unit tests can exercise it:
 * this module's `android.jar` is the gutted compile-time stub, so a test can
 * neither construct a real `android.graphics.Bitmap` nor ask one for its
 * `allocationByteCount`. Production uses `BitmapLruCache<Bitmap>` sized by
 * `Bitmap.allocationByteCount` (see NodeViewFactory.kt); the eviction
 * behaviour under test here is identical regardless of the value type.
 *
 * Values are modelled as [SizedValue] so a test can state a bitmap's byte
 * cost independently of its identity — which is the whole point of the
 * bound being bytes rather than an entry count.
 */
class ImageCacheTest {

    private data class SizedValue(val name: String, val bytes: Long)

    private fun cacheOf(maxBytes: Long) =
        BitmapLruCache<SizedValue>(maxBytes = maxBytes, sizeOf = { it.bytes })

    private fun value(name: String, bytes: Long) = SizedValue(name, bytes)

    // ---- LRU ordering ---------------------------------------------------

    @Test
    fun `a second get for the same key does not miss`() {
        val cache = cacheOf(maxBytes = TEN_BYTES)
        cache.put("a", value("bitmap-a", ONE_BYTE))
        assertEquals(value("bitmap-a", ONE_BYTE), cache.get("a"))
    }

    @Test
    fun `evicts the least recently used entry past the bound`() {
        val cache = cacheOf(maxBytes = TWO_BYTES)
        cache.put("a", value("A", ONE_BYTE))
        cache.put("b", value("B", ONE_BYTE))
        cache.get("a") // "a" is now the most recently used
        cache.put("c", value("C", ONE_BYTE)) // evicts "b", not "a"
        assertNotNull(cache.get("a"))
        assertNull(cache.get("b"))
        assertEquals(2, cache.size)
    }

    // ---- The bound is BYTES, not entries --------------------------------
    //
    // The whole point of I6: with an entry-count bound, a carousel of large
    // heroes could retain N full-size bitmaps and call it a cache. These
    // tests fail if the bound is ever put back on the entry count.

    @Test
    fun `one large value evicts many small ones, because the bound is bytes`() {
        val cache = cacheOf(maxBytes = TEN_BYTES)
        // Eight entries, comfortably under any plausible entry-count bound,
        // but exactly at the byte bound.
        repeat(EIGHT_ENTRIES) { index -> cache.put("small-$index", value("S$index", ONE_BYTE)) }
        assertEquals(EIGHT_ENTRIES, cache.size)

        cache.put("large", value("L", EIGHT_BYTES))

        // 8 small + 8 large = 16 > 10, so the six least-recently-used small
        // entries go. An entry-count bound would have evicted none of them.
        assertEquals(TEN_BYTES, cache.byteSize)
        assertNotNull(cache.get("large"))
        assertNull(cache.get("small-0"))
        assertNull(cache.get("small-5"))
        assertNotNull(cache.get("small-6"))
        assertNotNull(cache.get("small-7"))
        assertEquals(3, cache.size)
    }

    @Test
    fun `many small values are all retained under the same bound`() {
        val cache = cacheOf(maxBytes = TEN_BYTES)
        repeat(TEN_ENTRIES) { index -> cache.put("k$index", value("V$index", ONE_BYTE)) }
        assertEquals(TEN_ENTRIES, cache.size)
        assertEquals(TEN_BYTES, cache.byteSize)
    }

    @Test
    fun `byteSize tracks insertions and evictions`() {
        val cache = cacheOf(maxBytes = TEN_BYTES)
        assertEquals(0L, cache.byteSize)
        cache.put("a", value("A", FOUR_BYTES))
        assertEquals(FOUR_BYTES, cache.byteSize)
        cache.put("b", value("B", FOUR_BYTES))
        assertEquals(EIGHT_BYTES, cache.byteSize)
        cache.put("c", value("C", FOUR_BYTES)) // 12 > 10 -> "a" evicted
        assertEquals(EIGHT_BYTES, cache.byteSize)
        assertNull(cache.get("a"))
    }

    @Test
    fun `re-putting the same key does not double-count its bytes`() {
        val cache = cacheOf(maxBytes = TEN_BYTES)
        cache.put("a", value("A", FOUR_BYTES))
        cache.put("a", value("A-again", FOUR_BYTES))
        assertEquals(1, cache.size)
        assertEquals(FOUR_BYTES, cache.byteSize)
    }

    @Test
    fun `a value larger than the whole bound is still cached, not self-evicted`() {
        // Otherwise nothing would ever be cached for an oversized image and
        // every view rebuild would refetch it.
        val cache = cacheOf(maxBytes = TWO_BYTES)
        cache.put("a", value("A", ONE_BYTE))
        cache.put("huge", value("H", TEN_BYTES))
        assertNotNull(cache.get("huge"))
        assertNull(cache.get("a"))
        assertEquals(1, cache.size)
    }

    @Test
    fun `the shipped bound is expressed in bytes and is a real memory figure`() {
        assertEquals(IMAGE_CACHE_MAX_MIB * BYTES_PER_MIB, IMAGE_CACHE_MAX_BYTES)
        assertTrue(IMAGE_CACHE_MAX_BYTES > BYTES_PER_MIB, "a sub-megabyte bitmap cache would be pointless")
    }

    // ---- sampleSizeFor --------------------------------------------------

    @Test
    fun `sampleSizeFor halves until the source fits the target`() {
        assertEquals(1, sampleSizeFor(100, 100, 100, 100))
        assertEquals(2, sampleSizeFor(200, 200, 100, 100))
        // NOTE: the task brief asserted 4 here, but the algorithm it also
        // specifies (matching the "largest power of two that still covers
        // the target" doc comment on sampleSizeFor) computes 8: 800/8=100
        // still covers the 100 target, and 800/16=50 does not. 4 would
        // leave the image 2x oversized versus the documented intent.
        // Verified by hand and by executing this assertion against the
        // as-specified implementation before changing it.
        assertEquals(8, sampleSizeFor(800, 800, 100, 100))
    }

    @Test
    fun `sampleSizeFor never returns less than one for a zero target`() {
        assertEquals(1, sampleSizeFor(800, 800, 0, 0))
    }

    @Test
    fun `sampleSizeFor downsamples a real hero into a real slot`() {
        // The §2 claim, at the sizes it was written about: a 2000px-wide
        // hero landing in a phone-width, ~300px-tall slot. 2000/4 = 500 >=
        // 300 wide and 1200/4 = 300 >= 300 tall; the next step (8) would
        // give 150px of height for a 300px slot, so 4 is the answer.
        assertEquals(4, sampleSizeFor(2000, 1200, 300, 300))
        // And a 1080x1920 page into a 1080-wide phone slot is already the
        // right size — never blur an image that fits.
        assertEquals(1, sampleSizeFor(1080, 1920, 1080, 1920))
    }

    @Test
    fun `sampleSizeFor lets the short axis govern an asymmetric target`() {
        // Both axes must still cover, so a wide-but-short target cannot
        // downsample past what the width needs.
        assertEquals(1, sampleSizeFor(2000, 100, 100, 100))
        assertEquals(2, sampleSizeFor(400, 400, 200, 100))
    }

    private companion object {
        const val ONE_BYTE = 1L
        const val TWO_BYTES = 2L
        const val FOUR_BYTES = 4L
        const val EIGHT_BYTES = 8L
        const val TEN_BYTES = 10L
        const val EIGHT_ENTRIES = 8
        const val TEN_ENTRIES = 10
        const val BYTES_PER_MIB = 1024L * 1024L
    }
}
