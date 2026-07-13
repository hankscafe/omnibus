"use client"

import { SessionProvider, useSession } from "next-auth/react"
import { useEffect, useRef } from "react"

// The jwt callback no longer counts ambient session reads (the 300s refetch below, background
// polls) as activity, so this tracker is the only thing that slides the inactivity window:
// it pings the session (trigger "update") on genuine user input, throttled to one ping per
// interval so we don't hammer /api/auth/session on every keystroke or page-turn.
const ACTIVITY_PING_INTERVAL_MS = 5 * 60 * 1000;

export function SessionActivityTracker() {
  const { data: session, update } = useSession();
  // 0 = ping on the first input after mount, so a hard reload mid-session registers immediately.
  const lastPingRef = useRef(0);
  const updateRef = useRef(update);
  updateRef.current = update;
  const hasUser = !!session?.user;

  useEffect(() => {
    if (!hasUser) return;
    const onActivity = () => {
      if (Date.now() - lastPingRef.current < ACTIVITY_PING_INTERVAL_MS) return;
      lastPingRef.current = Date.now();
      Promise.resolve(updateRef.current()).catch(() => {});
    };
    const events: (keyof WindowEventMap)[] = ["pointerdown", "keydown", "wheel", "touchstart"];
    events.forEach(e => window.addEventListener(e, onActivity, { passive: true }));
    return () => events.forEach(e => window.removeEventListener(e, onActivity));
  }, [hasUser]);

  return null;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider
      // Refetch session every 5 minutes (300 seconds)
      // to automatically log out the user if the server session expired
      refetchInterval={300}
      // Optionally, refetch when the user switches tabs back to the app
      refetchOnWindowFocus={true}
    >
      <SessionActivityTracker />
      {children}
    </SessionProvider>
  )
}
