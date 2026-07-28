package dev.rovenue.sdk.paywallui

private const val BYTES_PER_KIB = 1024L
private const val KIB_PER_MIB = 1024L

/** The bitmap cache's bound, in mebibytes. A paywall is a small tree with a
 *  handful of distinct images, but a `carousel` of full-bleed heroes is
 *  exactly the case where "a handful" is still tens of megabytes: an
 *  ARGB_8888 1080x1920 page is ~8 MiB on its own. */
internal const val IMAGE_CACHE_MAX_MIB = 16L

/**
 * Bound on the in-memory bitmap cache, **in bytes**.
 *
 * Deliberately NOT an entry count. An entry-count bound says nothing about
 * memory: N decoded bitmaps can be a few hundred KiB or a few hundred MiB
 * depending entirely on their pixel dimensions, so a count bound is a
 * memory cost dressed up as a saving. The cost that actually matters here
 * is heap, so heap is what is bounded.
 */
internal const val IMAGE_CACHE_MAX_BYTES = IMAGE_CACHE_MAX_MIB * KIB_PER_MIB * BYTES_PER_KIB

private const val LRU_INITIAL_CAPACITY = 16
private const val LRU_LOAD_FACTOR = 0.75f

/** `LinkedHashMap`'s access-order flag — the whole reason this is a
 *  `LinkedHashMap` and not a hand-written list. */
private const val LRU_ACCESS_ORDER = true

/** Byte total of an empty cache, and the floor a size accounting may reach. */
private const val NO_BYTES = 0L

/**
 * A least-recently-used cache keyed by image URL, bounded by the total
 * number of BYTES its values occupy (see [IMAGE_CACHE_MAX_BYTES]).
 *
 * Generic over its value type, and taking [sizeOf] as a parameter, ONLY so
 * the JVM unit tests can exercise it: this module's `android.jar` is the
 * gutted compile-time stub, so a test cannot construct a real `Bitmap` nor
 * ask one for its `allocationByteCount`. Production use is
 * `BitmapLruCache<Bitmap>` sized by `Bitmap.allocationByteCount`.
 *
 * `LinkedHashMap` in access order IS the LRU ordering — a `get` promotes an
 * entry to the most-recently-used end, which is also why every accessor is
 * `@Synchronized`: an access-order `get` *mutates* the map.
 *
 * Eviction is a loop rather than `removeEldestEntry`, because that hook can
 * only ever drop ONE entry per insertion. A byte bound can be blown past by
 * a single large bitmap, so getting back under it may need several
 * evictions at once.
 */
internal class BitmapLruCache<V>(
    private val maxBytes: Long = IMAGE_CACHE_MAX_BYTES,
    private val sizeOf: (V) -> Long,
) {
    private val map = LinkedHashMap<String, V>(LRU_INITIAL_CAPACITY, LRU_LOAD_FACTOR, LRU_ACCESS_ORDER)
    private var bytes = NO_BYTES

    @Synchronized fun get(url: String): V? = map[url]

    @Synchronized fun put(url: String, value: V) {
        // Remove first so a re-put of the same URL cannot double-count its
        // bytes; the fresh insert then lands at the most-recently-used end.
        map.remove(url)?.let { previous -> bytes -= sizeOf(previous) }
        map[url] = value
        bytes += sizeOf(value)
        evictDownToBound(keeping = url)
    }

    /** Entry count. Retained for diagnostics and tests — it is NOT the
     *  bound; [byteSize] against [maxBytes] is. */
    val size: Int @Synchronized get() = map.size

    /** Total bytes currently held, as reported by [sizeOf]. */
    val byteSize: Long @Synchronized get() = bytes

    /** Drops least-recently-used entries until the byte bound holds again.
     *  Not `@Synchronized` itself: it is only ever called from [put], which
     *  already holds the lock. */
    private fun evictDownToBound(keeping: String) {
        val iterator = map.entries.iterator()
        while (bytes > maxBytes && iterator.hasNext()) {
            val eldest = iterator.next()
            // A single value larger than the entire bound would otherwise
            // evict itself the instant it was inserted — nothing would ever
            // be cached and every view rebuild would refetch. Keep the value
            // just inserted and accept the one-off overshoot.
            if (eldest.key == keeping) continue
            bytes -= sizeOf(eldest.value)
            iterator.remove()
        }
    }
}

/** The [sampleSizeForWidth] result meaning "decode at full size". */
internal const val IMAGE_SAMPLE_SIZE_FULL = 1

/** [sampleSizeForWidth] halves resolution one power of two at a time. */
private const val IMAGE_SAMPLE_SIZE_STEP = 2

/** Width/height below which a view is treated as not yet measured. */
internal const val UNMEASURED_VIEW_DIMENSION_PX = 0

/**
 * The `BitmapFactory.Options.inSampleSize` for decoding a [sourceWidth]-wide
 * image into a [targetWidth]-wide slot: the largest power of two that still
 * covers the target width. Decoding a 2000 px hero at full size into a
 * 300 px slot is the waste this removes.
 *
 * WIDTH ONLY, DELIBERATELY — and this is a correctness constraint, not a
 * simplification. The previous two-dimension form needed a measured target
 * HEIGHT, and a paywall `image` is laid out `MATCH_PARENT` wide by
 * `WRAP_CONTENT` tall with `adjustViewBounds` (see `buildImage`): its height
 * comes FROM the decoded drawable's aspect ratio. Asking for it before the
 * decode is asking the decode for its own precondition — the deadlock this
 * function's signature now makes unrepresentable. Width is the dimension
 * that arrives without a drawable (`MATCH_PARENT` resolves as soon as the
 * parent lays out), so width is the only dimension the decode may depend on.
 *
 * Sampling by width alone can only ever decode MORE pixels than a
 * both-axes rule would (a taller-than-needed bitmap is never blurry, just
 * slightly larger), and for the `adjustViewBounds` case — where the source's
 * own aspect ratio supplies the height — it is exactly the right answer. The
 * memory saving the cache/downsample work was for is delivered either way:
 * halving width halves height too, so one sample step is still a 4x drop.
 *
 * A zero or unknown target width (a view not yet measured) yields
 * [IMAGE_SAMPLE_SIZE_FULL] — full quality — because guessing small would
 * ship a blurry image permanently. Callers must therefore not decode until
 * the target view has a measured width; see `loadImageInto`, which defers
 * the fetch until then precisely so this branch is not the one that always
 * runs.
 */
internal fun sampleSizeForWidth(sourceWidth: Int, targetWidth: Int): Int {
    if (targetWidth <= UNMEASURED_VIEW_DIMENSION_PX) return IMAGE_SAMPLE_SIZE_FULL
    var sample = IMAGE_SAMPLE_SIZE_FULL
    while (sourceWidth / (sample * IMAGE_SAMPLE_SIZE_STEP) >= targetWidth) {
        sample *= IMAGE_SAMPLE_SIZE_STEP
    }
    return sample
}
