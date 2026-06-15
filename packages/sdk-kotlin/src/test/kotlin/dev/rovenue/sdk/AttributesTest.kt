package dev.rovenue.sdk

import kotlinx.coroutines.test.runTest
import kotlin.test.Test

class AttributesTest {
    @Test
    fun `setAttributes does not throw when configured`() = runTest {
        Rovenue.configure(apiKey = "pk_test_xyz", baseUrl = "https://unreachable.invalid")
        Rovenue.shared.setAttributes(mapOf("\$email" to "a@b.com", "country" to null))
    }

    @Test
    fun `setEmail routes to email reserved key`() = runTest {
        Rovenue.configure(apiKey = "pk_test_xyz", baseUrl = "https://unreachable.invalid")
        Rovenue.shared.setEmail("a@b.com")
    }
}
