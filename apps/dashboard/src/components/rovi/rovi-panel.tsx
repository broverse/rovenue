import { useRovi } from "../../lib/hooks/useRovi";
import { RoviHeader } from "./rovi-header";
import { RoviEmptyState } from "./rovi-empty-state";

export function RoviPanel() {
  const { open, setOpen } = useRovi();

  return (
    <>
      {/* Mobile backdrop */}
      {open ? (
        <button
          type="button"
          aria-label="Close Rovi"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] md:hidden"
        />
      ) : null}

      {/* Drawer */}
      <aside
        role="complementary"
        aria-label="Rovi"
        className={
          "dark fixed right-0 top-0 z-50 flex h-screen w-full flex-col border-l border-rv-divider bg-rv-bg shadow-2xl transition-transform duration-200 ease-out " +
          "md:w-[380px] lg:w-[420px] " +
          (open ? "translate-x-0" : "translate-x-full")
        }
      >
        <RoviHeader />
        <div className="flex flex-1 flex-col overflow-hidden">
          <RoviEmptyState />
        </div>
      </aside>
    </>
  );
}
