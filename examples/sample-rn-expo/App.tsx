import { useEffect, useState } from "react";
import { SafeAreaView, Text, View } from "react-native";
import { Rovenue, useCurrentUser } from "@rovenue/react-native-sdk";

export default function App() {
  const [version, setVersion] = useState<string | null>(null);
  const user = useCurrentUser();

  useEffect(() => {
    Rovenue.configure({
      apiKey: "pk_smoke_test",
      baseUrl: "https://api.rovenue.io",
      debug: true,
    });
    setVersion(Rovenue.getVersion());
    Rovenue.setLogHandler((entry) => {
      console.log(`[rovenue:${entry.level}]`, entry.message, entry.data ?? "");
    });
  }, []);

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <View style={{ padding: 24, gap: 8 }}>
        <Text style={{ fontSize: 18, fontWeight: "600" }}>Rovenue SDK smoke</Text>
        <Text>SDK version: {version ?? "—"}</Text>
        <Text>anonId: {user?.anonId ?? "loading…"}</Text>
        <Text>knownUserId: {user?.knownUserId ?? "(not identified)"}</Text>
      </View>
    </SafeAreaView>
  );
}
