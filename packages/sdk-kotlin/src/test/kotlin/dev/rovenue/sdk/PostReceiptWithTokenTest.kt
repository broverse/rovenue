package dev.rovenue.sdk

import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class PostReceiptWithTokenTest {
    @BeforeEach
    fun setup() {
        Rovenue.resetForTesting()
        Rovenue.configure(apiKey = "test_pk", baseUrl = "http://127.0.0.1:0", debug = true)
    }

    @AfterEach
    fun teardown() {
        Rovenue.resetForTesting()
    }

    @Test
    fun acceptsOptionalObfuscatedIds() = runBlocking {
        try {
            Rovenue.shared.postGoogleReceipt(
                receipt = "token-blob",
                productId = "premium_monthly",
                obfuscatedAccountId = "550e8400-e29b-41d4-a716-446655440000",
                obfuscatedProfileId = "project-abc",
            )
        } catch (e: Throwable) {
            // expected network failure
        }
    }

    @Test
    fun worksWithoutObfuscatedIds() = runBlocking {
        try {
            Rovenue.shared.postGoogleReceipt(receipt = "token-blob", productId = "premium_monthly")
        } catch (e: Throwable) {
            // expected
        }
    }

    @Test
    fun appleReceiptAcceptsOptionalToken() = runBlocking {
        try {
            Rovenue.shared.postAppleReceipt(
                jws = "jws-blob",
                productId = "premium_monthly",
                appAccountToken = "550e8400-e29b-41d4-a716-446655440000",
            )
        } catch (e: Throwable) {
            // expected
        }
    }
}
