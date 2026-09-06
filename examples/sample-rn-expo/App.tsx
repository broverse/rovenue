import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  Rovenue,
  RovenueError,
  RovenuePaywallView,
  useCurrentUser,
  useEntitlements,
  useVirtualCurrencies,
  type LogEntry,
  type Offerings,
  type Package,
  type Paywall,
} from "@rovenue/react-native-sdk";

// ---------------------------------------------------------------------------
// Configuration — points at the LOCAL Rovenue API for now (not yet deployed).
// Start it with `docker compose up` (API on :3000), then:
//   • iOS simulator:   http://localhost:3000          (shares host network)
//   • Android emulator: http://10.0.2.2:3000          (host alias)
//   • Physical device:  http://<your-LAN-IP>:3000
// pk_smoke_test is a placeholder — replace with a real project public key to
// see live offerings / entitlements.
// NOTE: plain http needs an ATS exception on iOS; Expo dev builds allow
// localhost by default, otherwise add NSAllowsLocalNetworking.
// ---------------------------------------------------------------------------
// Exported so index.js can configure the SDK BEFORE the app mounts (see
// the note there) — the reactive hooks call native on mount and the native
// SDK fatalErrors if accessed before configure().
export const API_KEY = "rov_pub_F9WSmqmMB9ijsG4vQ_owy1q_uZLU3Q8y";
export const BASE_URL = "http://localhost:3000";

// Same placement identifier the Flutter, iOS (SwiftUI) and Android (Compose)
// examples use, so all four apps demonstrate one flow against the same
// server-side placement.
const PLACEMENT_IDENTIFIER = "onboarding";

export default function App() {
  const [version, setVersion] = useState<string | null>(null);
  const [appUserId, setAppUserId] = useState("");
  const [offerings, setOfferings] = useState<Offerings | null>(null);
  const [activePaywall, setActivePaywall] = useState<Paywall | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  // Reactive state from the SDK store — updates automatically when the SDK
  // fires ENTITLEMENTS_CHANGED / IDENTITY_CHANGED / VIRTUAL_CURRENCIES_CHANGED.
  // (Note: this app previously called a `useCreditBalance` hook that no
  // longer exists post the credit→virtual-currency rename — fixed here to
  // the current `useVirtualCurrencies` shape so the app typechecks.)
  const user = useCurrentUser();
  const entitlements = useEntitlements();
  const virtualCurrencies = useVirtualCurrencies();

  const appendLog = useCallback((line: string) => {
    setLogs((prev) => [line, ...prev].slice(0, 50));
  }, []);

  // configure() must run once before any other SDK call.
  const configured = useRef(false);
  useEffect(() => {
    if (configured.current) return;
    configured.current = true;

    // configure() already ran in index.js (before mount). Here we just
    // attach the log handler + read the version.
    Rovenue.setLogHandler((entry: LogEntry) => {
      appendLog(`[${entry.level}] ${entry.message}`);
    });
    setVersion(Rovenue.getVersion());

    // Observe SDK change events (for the log panel only). Do NOT call
    // refreshEntitlements/refreshVirtualCurrencies here: a successful refresh
    // itself emits ENTITLEMENTS_CHANGED / VIRTUAL_CURRENCIES_CHANGED, so
    // re-fetching on the event creates an infinite loop. The reactive hooks
    // (useEntitlements / useVirtualCurrencies) already update from the store
    // when these events fire — no manual refetch needed.
    const unsubscribe = Rovenue.addChangeListener((event) => {
      appendLog(`change: ${event}`);
    });
    return unsubscribe;
  }, [appendLog]);

  // Wrap an async SDK call with a busy flag + structured error surfacing.
  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setBusy(label);
      try {
        await fn();
        appendLog(`ok: ${label}`);
      } catch (err) {
        const msg =
          err instanceof RovenueError
            ? `${err.constructor.name}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        appendLog(`error: ${label} — ${msg}`);
      } finally {
        setBusy(null);
      }
    },
    [appendLog],
  );

  const onIdentify = () =>
    run("identify", () => Rovenue.identify(appUserId.trim()));
  const onLogOut = () => run("logOut", () => Rovenue.logOut());
  const onLoadOfferings = () =>
    run("getOfferings", async () => {
      setOfferings(await Rovenue.getOfferings());
    });
  const onRestore = () => run("restorePurchases", () => Rovenue.restorePurchases());
  const onPurchase = (pkg: Package) =>
    run(`purchase ${pkg.product.id}`, () => Rovenue.purchase(pkg));

  // getPaywall() resolves a placement to either a direct assignment or the
  // winning variant of a client-drawn PAYWALL experiment — `null` means the
  // placement resolved to nothing (retired, target: none, unknown
  // identifier), not an error. RovenuePaywallView takes the ALREADY-RESOLVED
  // Paywall (same shape as the iOS example), not a placement identifier —
  // it hosts the native Swift/Kotlin paywall renderer, it is not a fourth
  // JS renderer.
  const onOpenPaywall = () =>
    run("getPaywall", async () => {
      const paywall = await Rovenue.getPaywall(PLACEMENT_IDENTIFIER);
      if (!paywall) {
        appendLog(
          `getPaywall(${PLACEMENT_IDENTIFIER}) resolved to nothing (no assignment for this placement)`,
        );
        return;
      }
      appendLog(
        `getPaywall(${PLACEMENT_IDENTIFIER}) succeeded: paywall ${paywall.paywallIdentifier ?? "(remote-config only)"}`,
      );
      setActivePaywall(paywall);
    });

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.h1}>Rovenue SDK</Text>
        <Text style={styles.muted}>v{version ?? "—"} · {BASE_URL}</Text>

        {/* Identity */}
        <Section title="Identity">
          <Row label="rovenueId" value={user?.rovenueId ?? "loading…"} />
          <Row label="appUserId" value={user?.appUserId ?? "(anonymous)"} />
          <TextInput
            style={styles.input}
            placeholder="appUserId to identify"
            autoCapitalize="none"
            value={appUserId}
            onChangeText={setAppUserId}
          />
          <View style={styles.btnRow}>
            <Button title="Identify" onPress={onIdentify} disabled={!appUserId.trim()} />
            <Button title="Log out" onPress={onLogOut} />
          </View>
        </Section>

        {/* Entitlements + virtual currencies (reactive hooks) */}
        <Section title="Access">
          {Object.keys(virtualCurrencies).length === 0 ? (
            <Text style={styles.muted}>No virtual currency balances</Text>
          ) : (
            Object.entries(virtualCurrencies).map(([code, amount]) => (
              <Row key={code} label={code} value={String(amount)} />
            ))
          )}
          {entitlements.length === 0 ? (
            <Text style={styles.muted}>No active entitlements</Text>
          ) : (
            entitlements.map((e) => (
              <Row
                key={e.id}
                label={e.id}
                value={e.active ? `active${e.expiresAt ? ` → ${e.expiresAt}` : ""}` : "inactive"}
              />
            ))
          )}
          <View style={styles.btnRow}>
            <Button title="Refresh entitlements" onPress={() => run("refreshEntitlements", () => Rovenue.refreshEntitlements())} />
            <Button title="Restore" onPress={onRestore} />
          </View>
        </Section>

        {/* Offerings / paywall */}
        <Section title="Offerings">
          <Button title="Load offerings" onPress={onLoadOfferings} />
          {offerings?.current ? (
            <View style={{ gap: 6, marginTop: 8 }}>
              <Text style={styles.muted}>current: {offerings.current.identifier}</Text>
              {offerings.current.packages.map((pkg) => (
                <View key={pkg.identifier} style={styles.pkg}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pkgName}>{pkg.product.displayName}</Text>
                    <Text style={styles.muted}>
                      {pkg.product.priceString ?? "—"} · {pkg.product.type}
                    </Text>
                  </View>
                  <Button title="Buy" onPress={() => onPurchase(pkg)} />
                </View>
              ))}
            </View>
          ) : offerings ? (
            <Text style={styles.muted}>No current offering</Text>
          ) : null}
        </Section>

        {/* Paywall — RovenuePaywallView hosts the native Swift/Kotlin
            paywall renderer; it takes an already-resolved Paywall, so we
            resolve the placement with getPaywall() first. */}
        <Section title="Paywall">
          <Button
            title={`Open paywall (${PLACEMENT_IDENTIFIER})`}
            onPress={onOpenPaywall}
          />
        </Section>

        {/* Log */}
        <Section title="Log">
          {logs.length === 0 ? (
            <Text style={styles.muted}>—</Text>
          ) : (
            logs.map((l, i) => (
              <Text key={i} style={styles.logLine}>{l}</Text>
            ))
          )}
        </Section>
      </ScrollView>

      {busy ? (
        <View style={styles.busy}>
          <ActivityIndicator />
          <Text style={styles.busyText}>{busy}…</Text>
        </View>
      ) : null}

      {/* Full-screen presentation of the resolved paywall. All five
          callbacks route into the same rolling log the rest of the app
          uses — mirrors the iOS (PaywallSheet) and Flutter (PaywallScreen)
          examples' event wiring. */}
      <Modal
        visible={activePaywall !== null}
        animationType="slide"
        onRequestClose={() => setActivePaywall(null)}
      >
        {activePaywall ? (
          <SafeAreaView style={styles.safe}>
            <RovenuePaywallView
              paywall={activePaywall}
              onPurchaseCompleted={(result) => {
                appendLog(`paywall: onPurchaseCompleted: ${result.productId}`);
                setActivePaywall(null);
                run("refreshEntitlements", () => Rovenue.refreshEntitlements());
              }}
              onPurchaseFailed={(err) => {
                const msg =
                  err instanceof RovenueError
                    ? `${err.constructor.name}: ${err.message}`
                    : err instanceof Error
                      ? err.message
                      : String(err);
                appendLog(`paywall: onPurchaseFailed: ${msg}`);
              }}
              onClose={() => {
                appendLog("paywall: onClose");
                setActivePaywall(null);
              }}
              onRestore={() => {
                appendLog("paywall: onRestore");
                onRestore();
              }}
              onUrl={(url) => appendLog(`paywall: onUrl: ${url}`)}
            />
          </SafeAreaView>
        ) : null}
      </Modal>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function Button({
  title,
  onPress,
  disabled,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={[styles.btn, disabled && styles.btnDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.btnText}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#0b0b0f" },
  container: { padding: 20, gap: 16 },
  h1: { fontSize: 24, fontWeight: "700", color: "#fff" },
  h2: { fontSize: 13, fontWeight: "700", color: "#8b8b96", textTransform: "uppercase", letterSpacing: 1 },
  muted: { color: "#8b8b96", fontSize: 13 },
  section: { gap: 8, backgroundColor: "#16161d", borderRadius: 12, padding: 16 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  rowLabel: { color: "#8b8b96", fontSize: 14 },
  rowValue: { color: "#fff", fontSize: 14, flexShrink: 1 },
  input: {
    borderWidth: 1, borderColor: "#2a2a36", borderRadius: 8, paddingHorizontal: 12,
    paddingVertical: 10, color: "#fff", marginTop: 4,
  },
  btnRow: { flexDirection: "row", gap: 8, flexWrap: "wrap", marginTop: 4 },
  btn: { backgroundColor: "#4f46e5", borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10 },
  btnDisabled: { opacity: 0.4 },
  btnText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  pkg: { flexDirection: "row", alignItems: "center", gap: 12, borderTopWidth: 1, borderTopColor: "#2a2a36", paddingTop: 8 },
  pkgName: { color: "#fff", fontSize: 15, fontWeight: "600" },
  logLine: { color: "#9aa0a6", fontSize: 12, fontFamily: "Courier" },
  busy: {
    position: "absolute", bottom: 24, alignSelf: "center", flexDirection: "row",
    gap: 8, backgroundColor: "#16161d", paddingHorizontal: 16, paddingVertical: 10,
    borderRadius: 24, alignItems: "center",
  },
  busyText: { color: "#fff", fontSize: 13 },
});
