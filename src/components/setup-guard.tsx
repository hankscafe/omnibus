"use client"

import { useEffect, useState } from "react"
import { useRouter, usePathname } from "next/navigation"
import { Loader2 } from "lucide-react"

export function SetupGuard({ children }: { children: React.ReactNode }) {
    const router = useRouter()
    const pathname = usePathname()
    const [isChecking, setIsChecking] = useState(true)
    const [setupComplete, setSetupComplete] = useState(false)

    useEffect(() => {
        // 1. If we already know the app is set up, do nothing
        if (setupComplete) return;

        // 2. If they are already on the setup page, drop the shield
        if (pathname === '/setup') {
            setIsChecking(false);
            return;
        }

        // 3. Ping the database (with cache-busting for Next.js strict caching)
        fetch(`/api/setup/check?t=${Date.now()}`, { cache: 'no-store' })
            .then(res => res.json())
            .then(data => {
                if (data.requiresSetup) {
                    router.push('/setup');
                } else {
                    setSetupComplete(true);
                    setIsChecking(false);
                }
            })
            .catch(() => {
                // Fail open so users aren't locked out during a transient network error
                setIsChecking(false);
            });
    }, [pathname, router, setupComplete]);

    if (isChecking && pathname !== '/setup') {
        return (
            <div className="min-h-screen w-full flex items-center justify-center bg-slate-50 dark:bg-slate-950">
                <Loader2 className="w-10 h-10 animate-spin text-blue-500" />
            </div>
        )
    }

    return <>{children}</>
}