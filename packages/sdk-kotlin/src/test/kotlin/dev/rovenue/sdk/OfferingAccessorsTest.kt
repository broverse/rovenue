package dev.rovenue.sdk
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class OfferingAccessorsTest {
    @Test fun accessors() {
        val prod = StoreProduct("x", ProductType.SUBSCRIPTION, ProductCategory.SUBSCRIPTION, "x")
        val pkg = Package("\$rov_annual", PackageType.ANNUAL, prod)
        val off = Offering("default", true, listOf(pkg))
        assertEquals("\$rov_annual", off.annual?.identifier)
        assertNull(off.monthly)
        assertEquals(PackageType.ANNUAL, off.packageBy("\$rov_annual")?.packageType)
    }
}
