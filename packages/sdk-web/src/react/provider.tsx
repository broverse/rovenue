import { createContext, useContext, useEffect, type ReactNode } from "react";
import type { Rovenue } from "../index";

// =============================================================
// Provider
// =============================================================
//
// The client is CONSTRUCTED BY THE HOST and passed in, rather than built from
// options here. A provider that took `{ apiKey, apiUrl }` would rebuild the
// SDK whenever those props were reconstructed — which, given they are usually
// written as an inline object literal, is every render. That rebuilds the
// identity, the cache handle and the event queue each time, and the queue's
// unload listeners would accumulate.
//
// Making the host own the instance also means a non-React part of the same
// app shares one SDK rather than running a second, competing queue.

const RovenueContext = createContext<Rovenue | null>(null);

export function RovenueProvider({
  client,
  children,
}: {
  client: Rovenue;
  children: ReactNode;
}) {
  useEffect(() => {
    // Event flushing is a browser concern, so it starts here rather than in
    // configure(): configure() also runs during server rendering, where
    // there is nothing to listen to and nothing to flush.
    client.startEventQueue();
    return () => client.stopEventQueue();
  }, [client]);

  return (
    <RovenueContext.Provider value={client}>{children}</RovenueContext.Provider>
  );
}

export function useRovenue(): Rovenue {
  const client = useContext(RovenueContext);
  if (!client) {
    // React's own message for a missing context is "undefined is not an
    // object", which sends the reader looking in the wrong file.
    throw new Error(
      "[rovenue] useRovenue() was called outside a <RovenueProvider>. Wrap " +
        "the tree that uses Rovenue hooks in one, passing the client you " +
        "created with configure().",
    );
  }
  return client;
}
