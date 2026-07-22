package dev.rovenue.sdk.paywallui

import dev.rovenue.sdk.Offering
import dev.rovenue.sdk.Package
import dev.rovenue.sdk.PackageType
import dev.rovenue.sdk.Period
import dev.rovenue.sdk.PeriodUnit
import dev.rovenue.sdk.ProductCategory
import dev.rovenue.sdk.ProductType
import dev.rovenue.sdk.StoreProduct
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PaywallHelpersTest {
    private fun product(
        priceString: String? = "$9.99",
        period: Period? = Period(1, PeriodUnit.MONTH, "P1M"),
    ) = StoreProduct(
        id = "com.x.pro",
        type = ProductType.SUBSCRIPTION,
        productCategory = ProductCategory.SUBSCRIPTION,
        displayName = "Pro",
        priceString = priceString,
        subscriptionPeriod = period,
    )

    private fun pkg(identifier: String, product: StoreProduct = product()) =
        Package(identifier = identifier, packageType = PackageType.MONTHLY, product = product)

    private fun offering(vararg ids: String) =
        Offering(identifier = "default", isDefault = true, packages = ids.map { pkg(it) })

    // ----- packageView mapping (normative formula, identical to Swift) -----

    @Test
    fun `packageView subscription periods`() {
        val month = packageView(product(), "Pro Monthly")
        assertEquals(PackageView("Pro Monthly", "$9.99", "$9.99/month", "month"), month)

        val year = packageView(product(period = Period(1, PeriodUnit.YEAR, "P1Y")), "Pro Annual")
        assertEquals("\$9.99/year", year.pricePerPeriod)
        assertEquals("year", year.period)

        assertEquals("week", packageView(product(period = Period(1, PeriodUnit.WEEK, "P1W")), "W").period)
        assertEquals("day", packageView(product(period = Period(1, PeriodUnit.DAY, "P1D")), "D").period)
    }

    @Test
    fun `packageView non-subscription and null product`() {
        val nonSub = packageView(product(period = null), "Lifetime")
        assertEquals("", nonSub.period)
        assertEquals("\$9.99", nonSub.pricePerPeriod) // price alone when no period

        val missing = packageView(null, "Ghost")
        assertEquals(PackageView("Ghost", "", "", ""), missing)

        val noPrice = packageView(product(priceString = null), "NoPrice")
        assertEquals("", noPrice.price)
        assertEquals("/month", noPrice.pricePerPeriod) // "" + "/month"
    }

    // ----- effectivePackageIds / initialSelection -----

    private fun packageList(
        packageIds: List<String>,
        defaultSelected: String? = null,
    ) = BuilderNode.PackageList(
        id = "pl", packageIds = packageIds, defaultSelected = defaultSelected,
        cellLayout = CellLayout.COLUMN,
    )

    private fun rootWith(vararg children: BuilderNode) =
        BuilderNode.Stack(id = "r", axis = Axis.V, children = children.toList())

    @Test
    fun `empty packageIds means all offering packages`() {
        val ids = effectivePackageIds(packageList(emptyList()), offering("\$rov_m", "\$rov_y"))
        assertEquals(listOf("\$rov_m", "\$rov_y"), ids)
        assertEquals(listOf("a"), effectivePackageIds(packageList(listOf("a")), offering("\$rov_m")))
        assertEquals(emptyList<String>(), effectivePackageIds(packageList(emptyList()), null))
    }

    @Test
    fun `initialSelection defaultSelected wins then first effective then null`() {
        val o = offering("\$rov_m", "\$rov_y")
        assertEquals(
            "\$rov_y",
            initialSelection(rootWith(packageList(listOf("\$rov_m", "\$rov_y"), "\$rov_y")), o),
        )
        assertEquals("\$rov_m", initialSelection(rootWith(packageList(emptyList())), o))
        assertNull(initialSelection(rootWith(packageList(emptyList())), null))
        assertNull(initialSelection(rootWith(BuilderNode.Spacer(id = "s")), o))
    }

    @Test
    fun `initialSelection searches primary tree not fallback subtrees`() {
        val hidden = BuilderNode.Text(
            id = "t", key = "k", role = TextRole.BODY,
            fallback = packageList(listOf("\$rov_m")),
        )
        assertNull(initialSelection(rootWith(hidden), offering("\$rov_m")))
    }
}
