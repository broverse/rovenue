package dev.rovenue.sdk.paywallui

/** Bound on the in-memory bitmap cache. Paywalls are small trees with a
 *  handful of distinct images; this is sized to hold a whole paywall's
 *  worth several times over without becoming a memory footprint of its
 *  own. */
internal const val IMAGE_CACHE_MAX_ENTRIES = 32

/**
 * A least-recently-used cache keyed by image URL.
 *
 * Generic over its value type ONLY so the JVM unit tests can exercise it:
 * this module's `android.jar` is the gutted compile-time stub, so a test
 * cannot construct a real `Bitmap`. Production use is `BitmapLruCache<Bitmap>`.
 *
 * `LinkedHashMap` in access order IS the LRU — `removeEldestEntry` is the
 * eviction hook, so this is deliberately not a hand-written list.
 */
internal class BitmapLruCache<V>(private val maxEntries: Int = IMAGE_CACHE_MAX_ENTRIES) {
    private val map = object : LinkedHashMap<String, V>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, V>?): Boolean =
            size > maxEntries
    }

    @Synchronized fun get(url: String): V? = map[url]
    @Synchronized fun put(url: String, value: V) { map[url] = value }
    val size: Int @Synchronized get() = map.size
}

/**
 * The `BitmapFactory.Options.inSampleSize` for decoding a [sourceWidth] x
 * [sourceHeight] image into a [targetWidth] x [targetHeight] slot: the
 * largest power of two that still covers the target. Decoding a 2000 px
 * hero at full size into a 300 px slot is the waste this removes.
 *
 * A zero or unknown target (a view not yet measured) yields 1 — full
 * quality — because guessing small would ship a blurry image permanently.
 */
internal fun sampleSizeFor(sourceWidth: Int, sourceHeight: Int, targetWidth: Int, targetHeight: Int): Int {
    if (targetWidth <= 0 || targetHeight <= 0) return 1
    var sample = 1
    while (sourceWidth / (sample * 2) >= targetWidth && sourceHeight / (sample * 2) >= targetHeight) {
        sample *= 2
    }
    return sample
}
