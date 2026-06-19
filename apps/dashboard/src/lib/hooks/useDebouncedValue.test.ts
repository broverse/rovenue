import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDebouncedValue } from "./useDebouncedValue";

describe("useDebouncedValue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the initial value immediately", () => {
    const { result } = renderHook(() => useDebouncedValue("a", 400));
    expect(result.current).toBe("a");
  });

  it("delays updates until the value is stable for the delay", () => {
    const { result, rerender } = renderHook(
      ({ v }) => useDebouncedValue(v, 400),
      { initialProps: { v: "a" } },
    );
    rerender({ v: "ab" });
    expect(result.current).toBe("a"); // not yet
    act(() => vi.advanceTimersByTime(399));
    expect(result.current).toBe("a");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe("ab");
  });

  it("resets the timer when the value keeps changing", () => {
    const { result, rerender } = renderHook(
      ({ v }) => useDebouncedValue(v, 400),
      { initialProps: { v: "a" } },
    );
    rerender({ v: "ab" });
    act(() => vi.advanceTimersByTime(300));
    rerender({ v: "abc" });
    act(() => vi.advanceTimersByTime(300));
    expect(result.current).toBe("a"); // never settled
    act(() => vi.advanceTimersByTime(100));
    expect(result.current).toBe("abc");
  });
});
