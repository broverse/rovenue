package dev.rovenue.sdk.internal

import android.content.Context

/**
 * Reads an `assets/` entry as UTF-8 text, always closing the stream.
 *
 * Extracted from [dev.rovenue.sdk.Rovenue.setFallbackPlacements]'s
 * context-and-asset-path overload so the only behaviour that overload adds
 * over the `json:` one — locating, reading and decoding the asset — is
 * unit-testable without a live core or an Android runtime (the module has
 * no Android-runtime test framework; see RovenuePaywallView.kt's class doc).
 *
 * @throws java.io.IOException when the asset can't be opened or read.
 */
internal fun readAssetText(context: Context, assetPath: String): String =
    context.assets.open(assetPath).use { it.readBytes().decodeToString() }
