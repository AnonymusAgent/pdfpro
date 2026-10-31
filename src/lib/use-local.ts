"use client";

import { useSyncExternalStore } from "react";

const EVENT = "pdfpro-local";

/** Writes a localStorage value and notifies every subscribed component in this tab. */
export function setLocal(key: string, value: string | null): void {
  if (value === null) window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, value);
  window.dispatchEvent(new Event(EVENT));
}

/** Subscribes to a localStorage value (updates from this tab and other tabs). */
export function useLocal(key: string): string | null {
  return useSyncExternalStore(
    (notify) => {
      window.addEventListener(EVENT, notify);
      window.addEventListener("storage", notify);
      return () => {
        window.removeEventListener(EVENT, notify);
        window.removeEventListener("storage", notify);
      };
    },
    () => window.localStorage.getItem(key),
    () => null,
  );
}
