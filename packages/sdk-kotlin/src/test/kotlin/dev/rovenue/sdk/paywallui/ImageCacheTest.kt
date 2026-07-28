package dev.rovenue.sdk.paywallui

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * [BitmapLruCache] is generic over its value type ONLY so these JVM unit
 * tests can exercise the LRU logic with `String` values: this module's
 * `android.jar` is the gutted compile-time stub, so a test cannot
 * construct a real `android.graphics.Bitmap`. Production uses
 * `BitmapLruCache<Bitmap>` (see NodeViewFactory.kt); the LRU behavior
 * under test here is identical regardless of the value type.
 */
class ImageCacheTest {

    @Test
    fun `a second get for the same key does not miss`() {
        val cache = BitmapLruCache<String>(maxEntries = 2)
        cache.put("a", "bitmap-a")
        assertEquals("bitmap-a", cache.get("a"))
    }

    @Test
    fun `evicts the least recently used entry past the bound`() {
        val cache = BitmapLruCache<String>(maxEntries = 2)
        cache.put("a", "A"); cache.put("b", "B")
        cache.get("a")            // "a" is now the most recently used
        cache.put("c", "C")       // evicts "b", not "a"
        assertEquals("A", cache.get("a"))
        assertNull(cache.get("b"))
        assertEquals(2, cache.size)
    }

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
}
