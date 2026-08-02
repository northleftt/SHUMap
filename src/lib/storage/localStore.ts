import { useCallback, useRef, useSyncExternalStore } from "react";

const STORE_EVENT = "shumap:local-store";

export function readStore<T>(key: string, initialValue: T): T {
  const raw = localStorage.getItem(key);
  if (raw === null) return initialValue;
  return JSON.parse(raw) as T;
}

export function writeStore<T>(key: string, value: T): void {
  localStorage.setItem(key, JSON.stringify(value));
  window.dispatchEvent(new CustomEvent(STORE_EVENT, { detail: key }));
}

/**
 * localStorage-backed state shared across components on the same page.
 * Writes dispatch a custom event so every mounted consumer re-renders.
 */
export function useLocalStore<T>(key: string, initialValue: T): [T, (next: T | ((prev: T) => T)) => void] {
  const raw = useSyncExternalStore(
    (callback) => {
      const handler = (event: Event) => {
        if ((event as CustomEvent).detail === key) callback();
      };
      window.addEventListener(STORE_EVENT, handler);
      window.addEventListener("storage", callback);
      return () => {
        window.removeEventListener(STORE_EVENT, handler);
        window.removeEventListener("storage", callback);
      };
    },
    () => localStorage.getItem(key),
  );
  const value = raw === null ? initialValue : JSON.parse(raw) as T;
  const valueRef = useRef(value);
  valueRef.current = value;
  const setValue = useCallback((next: T | ((prev: T) => T)) => {
    const resolved = typeof next === "function" ? (next as (prev: T) => T)(valueRef.current) : next;
    writeStore(key, resolved);
  }, [key]);
  return [value, setValue];
}
