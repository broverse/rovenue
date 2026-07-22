package dev.rovenue.sdk.paywallui

import dev.rovenue.sdk.IntroPrice
import dev.rovenue.sdk.Offering
import dev.rovenue.sdk.Package
import dev.rovenue.sdk.PackageType
import dev.rovenue.sdk.PaymentMode
import dev.rovenue.sdk.Period
import dev.rovenue.sdk.PeriodUnit
import dev.rovenue.sdk.ProductCategory
import dev.rovenue.sdk.ProductType
import dev.rovenue.sdk.StoreProduct
import org.junit.jupiter.api.Test
import java.text.NumberFormat
import java.util.Currency
import java.util.Locale
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Mirrors [packageView]'s own currency formatting exactly (Locale.US
 *  `NumberFormat.getCurrencyInstance`) — self-consistent the same way
 *  PaywallViewModelHelpersTests.swift's `Decimal(...).formatted(.currency(
 *  code:))` calls are: the expectation is computed with the SAME formatting
 *  API the implementation uses, not a hardcoded string. */
private fun formatUsdForTest(amount: Double): String {
    val formatter = NumberFormat.getCurrencyInstance(Locale.US)
    formatter.currency = Currency.getInstance("USD")
    return formatter.format(amount)
}

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

    // ----- packageView Phase D3 optional fields (identical formula to Swift) -----

    @Test
    fun `pricePerWeek month year pass through verbatim from product`() {
        val p = product(period = Period(1, PeriodUnit.YEAR, "P1Y")).copy(
            priceString = "\$39.99",
            pricePerWeekString = "\$0.77", pricePerMonthString = "\$3.33", pricePerYearString = "\$39.99",
        )
        val view = packageView(p, "Annual")
        assertEquals("\$0.77", view.pricePerWeek)
        assertEquals("\$3.33", view.pricePerMonth)
        assertEquals("\$39.99", view.pricePerYear)
    }

    @Test
    fun `pricePerDay derived from numeric pricePerWeek and currencyCode`() {
        val p = product(priceString = "\$0.77", period = Period(1, PeriodUnit.WEEK, "P1W"))
            .copy(currencyCode = "USD", pricePerWeek = 0.77)
        val view = packageView(p, "Weekly")
        assertNotNull(view.pricePerDay)
        assertEquals(formatUsdForTest(0.77 / 7.0), view.pricePerDay)
    }

    @Test
    fun `pricePerDay null without numeric pricePerWeek`() {
        val p = product(priceString = "\$0.77", period = Period(1, PeriodUnit.WEEK, "P1W")).copy(currencyCode = "USD")
        val view = packageView(p, "Weekly")
        assertNull(view.pricePerDay)
    }

    @Test
    fun `pricePerDay null without currencyCode`() {
        val p = product(priceString = "\$0.77", period = Period(1, PeriodUnit.WEEK, "P1W")).copy(pricePerWeek = 0.77)
        val view = packageView(p, "Weekly")
        assertNull(view.pricePerDay)
    }

    @Test
    fun `introPrice and period from StoreProduct introPrice`() {
        val intro = IntroPrice(
            price = 0.99, priceString = "\$0.99", currencyCode = "USD",
            period = Period(1, PeriodUnit.WEEK, "P1W"), cycles = 1, paymentMode = PaymentMode.FREE_TRIAL,
        )
        val p = product(priceString = "\$39.99", period = Period(1, PeriodUnit.YEAR, "P1Y")).copy(introPrice = intro)
        val view = packageView(p, "Annual")
        assertEquals("\$0.99", view.introPrice)
        assertEquals("week", view.introPeriod)
    }

    @Test
    fun `introPrice and period null without intro offer`() {
        val p = product(priceString = "\$39.99", period = Period(1, PeriodUnit.YEAR, "P1Y"))
        val view = packageView(p, "Annual")
        assertNull(view.introPrice)
        assertNull(view.introPeriod)
    }

    @Test
    fun `relativeDiscount null without offering`() {
        val p = product(priceString = "\$39.99", period = Period(1, PeriodUnit.YEAR, "P1Y")).copy(pricePerYear = 39.99)
        val view = packageView(p, "Annual", offering = null)
        assertNull(view.relativeDiscount)
    }

    @Test
    fun `relativeDiscount null with fewer than two comparable packages`() {
        val annual = product(priceString = "\$39.99", period = Period(1, PeriodUnit.YEAR, "P1Y")).copy(pricePerYear = 39.99)
        val monthlyNoNumericPrice = product(priceString = "\$4.99", period = Period(1, PeriodUnit.MONTH, "P1M"))
        val o = Offering(
            identifier = "default", isDefault = true,
            packages = listOf(
                Package("annual", PackageType.ANNUAL, annual),
                Package("monthly", PackageType.MONTHLY, monthlyNoNumericPrice),
            ),
        )
        val view = packageView(annual, "Annual", offering = o)
        assertNull(view.relativeDiscount, "only 1 package has a numeric pricePerYear")
    }

    @Test
    fun `relativeDiscount computed across comparable offering packages, matches Swift`() {
        // Annual is the cheapest per-year; monthly (\$4.99*12=\$59.88/yr
        // equivalent) is the most expensive -> annual's discount vs. the max.
        val annual = product(priceString = "\$39.99", period = Period(1, PeriodUnit.YEAR, "P1Y")).copy(pricePerYear = 39.99)
        val monthly = product(priceString = "\$4.99", period = Period(1, PeriodUnit.MONTH, "P1M")).copy(pricePerYear = 59.88)
        val o = Offering(
            identifier = "default", isDefault = true,
            packages = listOf(Package("annual", PackageType.ANNUAL, annual), Package("monthly", PackageType.MONTHLY, monthly)),
        )
        val annualView = packageView(annual, "Annual", offering = o)
        // round((1 - 39.99/59.88) * 100) = round(33.22...) = 33 — MUST match
        // the Swift implementation's PaywallViewModelHelpersTests expectation
        // for the identical inputs (see PackageViewMapping.swift's doc).
        assertEquals("33%", annualView.relativeDiscount)

        val monthlyView = packageView(monthly, "Monthly", offering = o)
        // The max-priced package has 0% discount relative to itself.
        assertEquals("0%", monthlyView.relativeDiscount)
    }

    @Test
    fun `relativeDiscount null for product with no numeric pricePerYear`() {
        val annual = product(priceString = "\$39.99", period = Period(1, PeriodUnit.YEAR, "P1Y")).copy(pricePerYear = 39.99)
        val monthly = product(priceString = "\$4.99", period = Period(1, PeriodUnit.MONTH, "P1M")).copy(pricePerYear = 59.88)
        val lifetime = product(priceString = "\$99.99", period = null).copy(
            productCategory = ProductCategory.NON_SUBSCRIPTION, type = ProductType.NON_CONSUMABLE,
        )
        val o = Offering(
            identifier = "default", isDefault = true,
            packages = listOf(
                Package("annual", PackageType.ANNUAL, annual),
                Package("monthly", PackageType.MONTHLY, monthly),
                Package("lifetime", PackageType.LIFETIME, lifetime),
            ),
        )
        val view = packageView(lifetime, "Lifetime", offering = o)
        assertNull(view.relativeDiscount)
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
