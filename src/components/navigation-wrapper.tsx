"use client"

import { usePathname } from "next/navigation"

export function NavigationWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  // Define all paths where the Header/Footer should be hidden
  const isHiddenPage = pathname.startsWith('/reader') || pathname === '/login'

  if (isHiddenPage) {
    return null
  }

  return <>{children}</>
}