"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { SessionPayload } from "@/lib/session-types";

type SessionContextValue = {
  session: SessionPayload;
  premium: boolean;
  signedIn: boolean;
  refresh: () => Promise<SessionPayload | null>;
  signOut: () => Promise<void>;
  setSession: (payload: SessionPayload) => void;
};

const EMPTY: SessionPayload = {
  user: null,
  entitlements: null,
  notifications: [],
  features: { googleSignIn: false, cardCheckout: false, checkoutUnavailableReason: null },
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ initial, children }: { initial: SessionPayload | null; children: ReactNode }) {
  const [session, setSession] = useState<SessionPayload>(initial ?? EMPTY);
  const pathname = usePathname();

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) return null;
      const payload = (await response.json()) as SessionPayload;
      setSession(payload);
      return payload;
    } catch {
      return null;
    }
  }, []);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" } });
    setSession(EMPTY);
    window.location.assign("/");
  }, []);

  // Refresh after client-side navigation so plan/verification state stays current.
  useEffect(() => {
    // Navigation is an external event; refreshing the session keeps the header,
    // badge and entitlements in step after client-side routing.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [pathname, refresh]);

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      premium: session.entitlements?.plan === "premium" || session.user?.plan === "premium",
      signedIn: Boolean(session.user),
      refresh,
      signOut,
      setSession,
    }),
    [session, refresh, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSession must be used inside SessionProvider");
  return context;
}

/** Initials avatar used in the header and dashboard. */
export function userInitials(user: { displayName: string | null; email: string } | null): string {
  if (!user) return "?";
  const source = user.displayName?.trim() || user.email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const initials = parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
  return initials || source.slice(0, 2).toUpperCase();
}
