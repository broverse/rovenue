// Direct entry — registers the App.tsx smoke screen. The package's
// default `main` was `expo-router/entry`, but this sample has no `app/`
// routes; going through expo-router only drags in react-native-screens
// (whose Fabric codegen specs are incompatible with this RN's
// babel-plugin-codegen). Mounting the component directly keeps the
// bundle to App.tsx + react-native + the Rovenue SDK.
import { registerRootComponent } from "expo";
import App from "./App";

registerRootComponent(App);
