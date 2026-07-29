package dev.rovenue.sdk.paywallui

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.AttributeSet
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import dev.rovenue.sdk.Paywall
import dev.rovenue.sdk.Rovenue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * On-device preview of an unpublished paywall draft (dashboard "preview on
 * my device" flow, P9). Wraps the existing [RovenuePaywallView] renderer —
 * this is NOT a fourth renderer, just a different fetch path feeding the
 * same one. Fetches once on bind, then polls [Rovenue.getPaywallPreview]
 * every [PREVIEW_POLL_INTERVAL_MS] so an editor save shows up on the device
 * without the tester having to relaunch; a poll only swaps the rendered
 * paywall when [previewPollDecision] says the revision actually changed
 * (see PreviewPollDecision.kt). Mirrors the SwiftUI sibling
 * (`RovenuePaywallPreviewView.swift`) exactly.
 *
 * Preview must never charge: the wrapped [RovenuePaywallView] is always
 * bound with `previewMode = true` (see [buildPreviewWrappedOptions]), which
 * gates its internal `startPurchase()` FIRST via [purchaseGate] — a tap on
 * "Subscribe" here can never reach `Rovenue.shared.purchase`, not merely
 * suppress the reaction to it.
 *
 * Usage:
 * ```kotlin
 * val previewView = RovenuePaywallPreviewView(context)
 * container.addView(previewView)
 * previewView.bindPreview(token, PaywallViewOptions(onClose = { ... }))
 * ```
 */
class RovenuePaywallPreviewView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
) : FrameLayout(context, attrs, defStyleAttr) {

    private val paywallView = RovenuePaywallView(context)
    private val loadingView = ProgressBar(context)
    private val retryContainer: LinearLayout
    private val pillView: TextView

    private var token: String? = null
    private var hostOptions: PaywallViewOptions = PaywallViewOptions()
    private var shown: Paywall? = null
    private var loadError: Throwable? = null

    private var viewScope: CoroutineScope? = null
    private var pollJob: Job? = null

    init {
        addView(paywallView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))

        addView(
            loadingView,
            LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER),
        )

        retryContainer = buildRetryContainer(context)
        addView(
            retryContainer,
            LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER),
        )

        pillView = buildPillView(context)
        addView(
            pillView,
            LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.END).apply {
                topMargin = dp(context, PREVIEW_PILL_TOP_INSET_DP)
                marginEnd = dp(context, PREVIEW_PILL_TRAILING_INSET_DP)
            },
        )

        renderState()
    }

    /**
     * Fetches and renders an on-device preview of the draft identified by
     * the short-lived preview [token] (see [Rovenue.getPaywallPreview]).
     * [options]' `onPurchaseCompleted`/`onPurchaseFailed`/`onRestore` are
     * intentionally IGNORED — the wrapped [RovenuePaywallView] is always
     * bound with no-op purchase/restore callbacks AND `previewMode = true`
     * (see [buildPreviewWrappedOptions]' doc): previewing a draft must never
     * be mistaken for a completed sale, and must never even START a real
     * billing flow. `locale`/`darkMode`/`onClose`/`onUrl` pass straight
     * through.
     */
    fun bindPreview(token: String, options: PaywallViewOptions = PaywallViewOptions()) {
        this.token = token
        this.hostOptions = options
        this.shown = null
        this.loadError = null
        renderState()
        start()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (token != null && pollJob == null) start()
    }

    override fun onDetachedFromWindow() {
        stop()
        super.onDetachedFromWindow()
    }

    private fun scope(): CoroutineScope =
        viewScope ?: CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate).also { viewScope = it }

    private fun start() {
        stop()
        val scope = scope()
        scope.launch { fetchOnce() }
        pollJob = scope.launch {
            while (isActive) {
                delay(PREVIEW_POLL_INTERVAL_MS)
                poll()
            }
        }
    }

    /** Cancelled on detach — a preview left off-screen must not keep
     *  hitting the network every [PREVIEW_POLL_INTERVAL_MS]. */
    private fun stop() {
        pollJob?.cancel()
        pollJob = null
        viewScope?.cancel()
        viewScope = null
    }

    private suspend fun fetchOnce() {
        val currentToken = token ?: return
        try {
            val fetched = Rovenue.shared.getPaywallPreview(currentToken, hostOptions.locale)
            shown = fetched
            loadError = null
        } catch (e: Throwable) {
            loadError = e
        }
        renderState()
    }

    /**
     * A background poll tick: fetches, then only re-binds [shown] when
     * [previewPollDecision] says the revision actually moved — a poll that
     * returns the same (or no) revision must not tear down and rebuild the
     * view a tester is actively looking at.
     */
    private suspend fun poll() {
        val currentToken = token ?: return
        try {
            val fetched = Rovenue.shared.getPaywallPreview(currentToken, hostOptions.locale)
            if (previewPollDecision(current = shown?.revision, latest = fetched?.revision) != PreviewPollDecision.REFETCH) {
                return
            }
            shown = fetched
            loadError = null
            renderState()
        } catch (e: Throwable) {
            // Minimal retry state: a transient poll failure must not blow
            // away an already-rendered preview. Only surface the error when
            // there's nothing on screen yet (i.e. the initial fetch itself
            // never succeeded and a later poll also failed).
            if (shown == null) {
                loadError = e
                renderState()
            }
        }
    }

    private fun renderState() {
        val current = shown
        if (current != null) {
            paywallView.visibility = View.VISIBLE
            loadingView.visibility = View.GONE
            retryContainer.visibility = View.GONE
            paywallView.bind(current, buildPreviewWrappedOptions(hostOptions))
        } else if (loadError != null) {
            paywallView.visibility = View.GONE
            loadingView.visibility = View.GONE
            retryContainer.visibility = View.VISIBLE
        } else {
            paywallView.visibility = View.GONE
            loadingView.visibility = View.VISIBLE
            retryContainer.visibility = View.GONE
        }
    }

    private fun buildRetryContainer(context: Context): LinearLayout {
        val message = TextView(context).apply {
            text = "Couldn't load preview"
            setTextColor(Color.BLACK)
        }
        val retryButton = Button(context).apply {
            text = "Retry"
            setOnClickListener {
                loadError = null
                renderState()
                scope().launch { fetchOnce() }
            }
        }
        return LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            addView(message)
            addView(retryButton)
        }
    }

    private fun buildPillView(context: Context): TextView {
        val pillBackground = GradientDrawable().apply {
            setColor(Color.argb(PREVIEW_PILL_BACKGROUND_ALPHA, 0, 0, 0))
            cornerRadius = dp(context, PREVIEW_PILL_CORNER_RADIUS_DP).toFloat()
        }
        return TextView(context).apply {
            text = "PREVIEW"
            setTextColor(Color.WHITE)
            textSize = PREVIEW_PILL_TEXT_SIZE_SP
            typeface = Typeface.DEFAULT_BOLD
            background = pillBackground
            setPadding(
                dp(context, PREVIEW_PILL_PADDING_HORIZONTAL_DP),
                dp(context, PREVIEW_PILL_PADDING_VERTICAL_DP),
                dp(context, PREVIEW_PILL_PADDING_HORIZONTAL_DP),
                dp(context, PREVIEW_PILL_PADDING_VERTICAL_DP),
            )
        }
    }
}

/**
 * The [PaywallViewOptions] the wrapped [RovenuePaywallView] is actually
 * bound with, given the preview host's [hostOptions]. Previewing a draft
 * must NEVER charge: `previewMode = true` gates [RovenuePaywallView]'s
 * internal `startPurchase()` FIRST via [purchaseGate], so a tap on
 * "Subscribe" here can never reach `Rovenue.purchase` at all — not merely
 * suppress the *reaction* to a purchase outcome via no-op callbacks (which
 * this also does, belt-and-braces). Restore is a no-op too — there is
 * nothing meaningful to restore against a draft that isn't published, and
 * [RovenuePaywallView] never calls a real restore API internally in the
 * first place (restore is entirely host-delegated via `onRestore`), so the
 * no-op closure alone already closed that path. `locale`/`darkMode`/
 * `onClose`/`onUrl` are pure navigation/cosmetic and pass straight through
 * to the preview host.
 *
 * A top-level, dependency-free pure function (not a private view method) so
 * it is directly unit-testable without constructing any Android views —
 * mirrors this module's other pure helpers (e.g. [previewPollDecision]).
 */
internal fun buildPreviewWrappedOptions(hostOptions: PaywallViewOptions): PaywallViewOptions = PaywallViewOptions(
    locale = hostOptions.locale,
    darkMode = hostOptions.darkMode,
    onPurchaseCompleted = {},
    onPurchaseFailed = {},
    onClose = hostOptions.onClose,
    onRestore = {},
    onUrl = hostOptions.onUrl,
    previewMode = true,
)

/** How often the poll loop re-fetches the preview while this view is on
 *  screen. Named rather than inlined per the "no magic values" convention —
 *  this is the one number a reviewer/future-editor would want to tune.
 *  Mirrors the SwiftUI sibling's `previewPollIntervalSeconds`. */
internal const val PREVIEW_POLL_INTERVAL_MS: Long = 2_000

// MARK: - "PREVIEW" pill styling constants (top-end overlay)

internal const val PREVIEW_PILL_TEXT_SIZE_SP: Float = 11f
internal const val PREVIEW_PILL_PADDING_HORIZONTAL_DP: Double = 10.0
internal const val PREVIEW_PILL_PADDING_VERTICAL_DP: Double = 4.0
internal const val PREVIEW_PILL_CORNER_RADIUS_DP: Double = 8.0

/** 0.85 opacity expressed as an 8-bit alpha channel value (0.85 * 255,
 *  rounded) — [android.graphics.Color.argb] takes an `Int` alpha, not a
 *  `Double` opacity. */
internal const val PREVIEW_PILL_BACKGROUND_ALPHA: Int = 217
internal const val PREVIEW_PILL_TOP_INSET_DP: Double = 12.0
internal const val PREVIEW_PILL_TRAILING_INSET_DP: Double = 12.0
