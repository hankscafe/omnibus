"use client"

import { SessionProvider, useSession, signOut } from "next-auth/react"
import { usePathname } from "next/navigation"
import { useEffect, useRef } from "react"
import { useToast } from "@/components/ui/use-toast"
import {
  SESSION_EXPIRED_TOAST, claimExpiryOnce, isGuardedApiUrl, isPublicPath, loginUrlFor, nav, sessionLooksExpired,
  sessionPayloadIsGone,
} from "@/lib/session-expiry-client"

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

/**
 * #204: the session ending — by the inactivity flag OR by the cookie simply lapsing — sends the
 * user to /login with a return path instead of leaving a dead page up. Two observers, one action:
 *   - the session itself: the flag, or an EMPTY session after a user was present here;
 *   - a 401 from our own /api while a user was present (the race where the click lands before the
 *     refetch does — the black "Unauthorized Access" dialog of the report), confirmed by the
 *     server's session endpoint: a route that refuses a signed-in user with 401 is not an expiry.
 * Public pages never bounce; it fires once per page life.
 */
export function SessionExpiryGuard() {
  const { data: session, status } = useSession();
  const pathname = usePathname();
  const { toast } = useToast();
  const hadUserRef = useRef(false);
  if (session?.user) hadUserRef.current = true;

  const fire = () => {
    if (isPublicPath(pathname ?? window.location.pathname) || !claimExpiryOnce()) return;
    toast({ ...SESSION_EXPIRED_TOAST, variant: "destructive" });
    const back = window.location.pathname + window.location.search;
    Promise.resolve(signOut({ redirect: false })).catch(() => {}).then(() => nav.go(loginUrlFor(back)));
  };
  const fireRef = useRef(fire);
  fireRef.current = fire;

  useEffect(() => {
    if (sessionLooksExpired(status, session?.error, hadUserRef.current)) fireRef.current();
  }, [status, session]);

  // The 401 net. Wraps window.fetch for this page's life; the caller still receives its response.
  // A 401 only prompts the question — /api/auth/session answers it, one check at a time, and a
  // check that can't be answered (server unreachable, a 500, not JSON) never signs anyone out.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const original = window.fetch;
    let checking = false;
    const confirmExpiry = async () => {
      if (checking) return;
      checking = true;
      try {
        const res = await original('/api/auth/session', { cache: 'no-store' });
        if (res.ok && sessionPayloadIsGone(await res.json())) fireRef.current();
      } catch {
        // No answer is no proof.
      } finally {
        checking = false;
      }
    };
    const wrapped: typeof window.fetch = async (input, init) => {
      const res = await original(input, init);
      if (res.status === 401 && hadUserRef.current && isGuardedApiUrl(input)) void confirmExpiry();
      return res;
    };
    window.fetch = wrapped;
    return () => { if (window.fetch === wrapped) window.fetch = original; };
  }, []);

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
      <SessionExpiryGuard />
      {children}
    </SessionProvider>
  )
}
