import { useContext } from "react";
import { RoviContext } from "../../components/rovi/rovi-provider";

export function useRovi() {
  const ctx = useContext(RoviContext);
  if (!ctx) {
    throw new Error("useRovi must be used inside <RoviProvider>");
  }
  return ctx;
}
