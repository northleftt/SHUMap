import { useSyncExternalStore } from "react";

const STORE_EVENT = "shumap:local-store";

export function readStore<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeStore<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full / private mode — keep the in-memory event so the UI stays consistent
  }
  window.dispatchEvent(new CustomEvent(STORE_EVENT, { detail: key }));
}

/**
 * localStorage-backed state shared across components on the same page.
 * Writes dispatch a custom event so every mounted consumer re-renders.
 */
export function useLocalStore<T>(key: string, fallback: T): [T, (next: T | ((prev: T) => T)) => void] {
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
  const value = raw === null ? fallback : readStore(key, fallback);
  const setValue = (next: T | ((prev: T) => T)) => {
    const resolved = typeof next === "function" ? (next as (prev: T) => T)(value) : next;
    writeStore(key, resolved);
  };
  return [value, setValue];
}
