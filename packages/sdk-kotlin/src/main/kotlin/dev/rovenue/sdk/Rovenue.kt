package dev.rovenue.sdk

import dev.rovenue.sdk.generated.sdkVersion

object Rovenue {
    val version: String
        get() = sdkVersion()
}
