"use client"

import { SessionProvider } from "next-auth/react"

export function AuthProvider({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider 
      // Refetch session every 5 minutes (300 seconds) 
      // to automatically log out the user if the server session expired
      refetchInterval={300} 
      // Optionally, refetch when the user switches tabs back to the app
      refetchOnWindowFocus={true} 
    >
      {children}
    </SessionProvider>
  )
}