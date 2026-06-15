# SDK API Ground Truth (source-verified)

Authoritative signatures extracted directly from SDK source. **Docs code samples MUST match these exactly.** Do NOT infer or invent — if something isn't here, leave the doc as-is and flag it.

Sources: `packages/sdk-swift/Sources/Rovenue/{Rovenue,Types,Errors}.swift`, `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/{Rovenue,Types}.kt`, `packages/sdk-rn/src/{index,types,api/*,hooks/*,errors}.ts`.

## ⚠️ Highest-risk platform differences (verify these first)
- **Kotlin `purchase` and `restorePurchases` REQUIRE an `Activity`:**
  - `suspend fun purchase(activity: Activity, pkg: Package): PurchaseResult`
  - `suspend fun purchase(activity: Activity, product: StoreProduct): PurchaseResult`
  - `suspend fun restorePurchases(activity: Activity): PurchaseResult`
  Swift and RN take NO activity. Any Kotlin sample calling `Rovenue.purchase(pkg)` / `restorePurchases()` without an `activity` is WRONG.
- **Change stream is a PROPERTY on native, a listener on RN:**
  - Swift: `public var changes: AsyncStream<ChangeEvent>` → `for await event in Rovenue.shared.changes { }`
  - Kotlin: `val changes: SharedFlow<ChangeEvent>` → `Rovenue.shared.changes.collect { }`
  - RN/TS: `Rovenue.addChangeListener((event) => {...})` returns an unsubscribe fn. There is NO `addChangeListener` on Swift/Kotlin.
- **`configure` differs per platform:**
  - RN/TS: `Rovenue.configure({ apiKey, baseUrl, debug?, appVersion? })` — single OBJECT arg.
  - Swift: `try Rovenue.configure(apiKey:, baseUrl:, debug: false, appVersion: nil)` — named args, `throws`, `static`. NO context.
  - Kotlin: `Rovenue.configure(apiKey, baseUrl, debug = false, appVersion = null, context = null)` — named args; `context: Context?` is OPTIONAL but REQUIRED for purchasing (pass `applicationContext`). On Android, pass `context` at configure so purchase/restore work.
- **Swift error enum case is `.internalError`** (NOT `.internal`). Full enum is `Rovenue.Error`.

## Method signatures

### Swift (`Rovenue.shared`, all `async`; `throws` where noted) — `import Rovenue`
- `static func configure(apiKey: String, baseUrl: String, debug: Bool = false, appVersion: String? = nil) throws`
- `func currentUser() async -> User`
- `func identify(_ appUserId: String) async throws`
- `func logOut() async throws`
- `func entitlement(_ id: String) async -> Entitlement?`
- `func entitlementsAll() async -> [Entitlement]`
- `func refreshEntitlements() async throws`
- `func creditBalance() async -> Int64`
- `func refreshCredits() async throws`
- `func consumeCredits(_ amount: Int64, description: String? = nil) async throws -> Int64`
- `func getOfferings() async throws -> Offerings`
- `func purchase(_ package: Package) async throws -> PurchaseResult` (also overload `purchase(_ product: StoreProduct)`)
- `func restorePurchases() async throws -> PurchaseResult`
- `func getAppAccountToken() async throws -> String`
- `func setForeground(_ foreground: Bool)`
- `func shutdown()`
- `func setLogHandler(_ handler: @escaping (LogEntry) -> Void) -> () -> Void`
- `var changes: AsyncStream<ChangeEvent>`

### Kotlin (`Rovenue.shared`, `suspend` where noted) — `import dev.rovenue.sdk.Rovenue`
- `fun configure(apiKey: String, baseUrl: String, debug: Boolean = false, appVersion: String? = null, context: Context? = null)`
- `suspend fun currentUser(): User`
- `suspend fun identify(appUserId: String)`
- `suspend fun logOut()`
- `suspend fun entitlement(id: String): Entitlement?`
- `suspend fun entitlementsAll(): List<Entitlement>`
- `suspend fun refreshEntitlements()`
- `suspend fun creditBalance(): Long`
- `suspend fun refreshCredits()`
- `suspend fun consumeCredits(amount: Long, description: String? = null): Long`
- `suspend fun getOfferings(): Offerings`
- `suspend fun purchase(activity: Activity, pkg: Package): PurchaseResult` (overload `purchase(activity, product: StoreProduct)`)
- `suspend fun restorePurchases(activity: Activity): PurchaseResult`
- `suspend fun getAppAccountToken(): String`
- `fun setForeground(foreground: Boolean)`
- `fun shutdown()`
- `fun setLogHandler(handler: (LogEntry) -> Unit): () -> Unit`
- `val changes: SharedFlow<ChangeEvent>`

### React Native / TS (`Rovenue.*`, all return `Promise`) — `import { Rovenue } from '@rovenue/react-native-sdk'`
- `Rovenue.configure({ apiKey, baseUrl, debug?, appVersion? })`
- `Rovenue.currentUser(): Promise<User>`
- `Rovenue.identify(appUserId: string): Promise<void>`
- `Rovenue.logOut(): Promise<void>`
- `Rovenue.entitlement(id: string): Promise<Entitlement | null>`
- `Rovenue.entitlementsAll(): Promise<Entitlement[]>`
- `Rovenue.refreshEntitlements(): Promise<void>`
- `Rovenue.creditBalance(): Promise<number>`
- `Rovenue.refreshCredits(): Promise<void>`
- `Rovenue.consumeCredits(amount: number, description?: string): Promise<number>`
- `Rovenue.getOfferings(): Promise<Offerings>`
- `Rovenue.purchase(target: Package | StoreProduct): Promise<PurchaseResult>` (NO activity)
- `Rovenue.restorePurchases(): Promise<PurchaseResult>` (NO activity)
- `Rovenue.getAppAccountToken(): Promise<string>`
- `Rovenue.setForeground(foreground: boolean): void`
- `Rovenue.shutdown(): void`
- `Rovenue.setLogHandler(handler): () => void`
- `Rovenue.addChangeListener(cb: (event: ChangeEvent) => void): () => void`
- Hooks (RN only): `useCurrentUser(): User | null`, `useEntitlement(id: string): Entitlement | null`, `useEntitlements(): Entitlement[]`, `useCreditBalance(): number`. (There is NO `useCredits`.)

## Types (canonical TS; field names identical across platforms)
- `User { rovenueId: string; appUserId: string | null }`
- `Entitlement { id; isActive; productIdentifier; store; expiresIso? }` — TS shape per reference/types.mdx (verify against `packages/sdk-rn/src/types.ts` if a sample uses a field).
- `ProductType = 'subscription' | 'consumable' | 'non_consumable'` (Swift `.subscription`/`.consumable`/`.nonConsumable`; Kotlin enum `ProductType.SUBSCRIPTION` etc. — confirm casing in Types.kt before using).
- `StoreProduct { id; type; displayName; priceString; price; currencyCode }`
- `Package { identifier; product: StoreProduct }`
- `Offering { identifier; isDefault; packages: Package[] }`
- `Offerings { current: Offering | null; all: Record<string, Offering> }`
- `PurchaseResult { entitlements: Entitlement[]; creditBalance; productId; storeTransactionId }`
- `ChangeEvent`: TS string union `'EntitlementsChanged' | 'IdentityChanged' | 'CreditBalanceChanged'`; Swift enum `.entitlementsChanged`/`.identityChanged`/`.creditBalanceChanged`; Kotlin enum `ChangeEvent.ENTITLEMENTS_CHANGED`/`.IDENTITY_CHANGED`/`.CREDIT_BALANCE_CHANGED`.

## Errors (exact names)
- TS classes (extend `RovenueError`): `InvalidApiKeyError`, `InvalidArgumentError`, `NotConfiguredError`, `NetworkUnavailableError`, `TimeoutError`, `RateLimitedError`, `ServerError`, `StorageError`, `UserNotFoundError`, `InsufficientCreditsError`, `EntitlementInactiveError`, `DuplicatePurchaseError`, `ReceiptInvalidError`, `PurchaseCancelledError`, `PurchasePendingError`, `ProductNotAvailableError`, `StoreProblemError`, `InternalError`.
- Swift `Rovenue.Error` cases (camelCase): `.notConfigured`, `.invalidApiKey`, `.invalidArgument`, `.serverError`, `.networkUnavailable`, `.timeout`, `.rateLimited`, `.storage`, `.userNotFound`, `.insufficientCredits`, `.entitlementInactive`, `.duplicatePurchase`, `.receiptInvalid`, `.internalError`, `.purchaseCancelled`, `.purchasePending`, `.productNotAvailable`, `.storeProblem`.
- Kotlin: **core** errors are sealed `RovenueException.X` (e.g. `RovenueException.InvalidApiKey`, `RovenueException.InsufficientCredits`, `RovenueException.InvalidArgument`). **Native purchase** errors are separate plain classes: `PurchaseCancelledException`, `PurchasePendingException`, `ProductNotAvailableException`, `StoreProblemException` (NOT `RovenueException.PurchaseCancelled`).

## Notes
- Numeric credit type: TS `number`, Swift `Int64`, Kotlin `Long`.
- Android purchasing needs `Activity` + `context` passed at `configure`. iOS/RN do not.
- `getVersion()` (TS) / version accessor exists; keep as-is if a sample uses it.
