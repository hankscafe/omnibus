// src/components/setup-guard.tsx
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
        // 1. If we already know the app is set up, do nothing and let them browse fast!
        if (setupComplete) return;

        // 2. If they are already on the setup page, drop the shield immediately
        if (pathname === '/setup') {
            setIsChecking(false);
            return;
        }

        // 3. Ping the database to check initialization status
        fetch('/api/setup/check')
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
                // If the API fails for some reason, fail open so we don't lock you out
                setIsChecking(false);
            });
    }, [pathname, router, setupComplete]);

    // 4. Block the UI completely until the check is done to prevent "flashing"
    if (isChecking && pathname !== '/setup') {
        return (
            <div className="min-h-screen w-full flex items-center justify-center bg-slate-50 dark:bg-slate-950">
                <Loader2 className="w-10 h-10 animate-spin text-blue-500" />
            </div>
        )
    }

    return <>{children}</>
}