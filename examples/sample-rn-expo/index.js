// Direct entry — registers the App.tsx smoke screen. The package's
// default `main` was `expo-router/entry`, but this sample has no `app/`
// routes; going through expo-router only drags in react-native-screens
// (whose Fabric codegen specs are incompatible with this RN's
// babel-plugin-codegen). Mounting the component directly keeps the
// bundle to App.tsx + react-native + the Rovenue SDK.
import { registerRootComponent } from "expo";
import { Rovenue } from "@rovenue/react-native-sdk";
import App, { API_KEY, BASE_URL } from "./App";

// Configure the SDK BEFORE the app mounts. The reactive hooks
// (useCurrentUser / useEntitlements / useCreditBalance) call into the
// native module on first render, and the native SDK raises a fatalError
// if `Rovenue.shared` is accessed before configure(). configure() is
// synchronous, so running it here guarantees the SDK is ready before any
// hook effect fires.
Rovenue.configure({ apiKey: API_KEY, baseUrl: BASE_URL, debug: true });

registerRootComponent(App);
