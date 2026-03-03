"use client"

import { usePathname } from "next/navigation"

export function HideOnReader({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  
  // If the URL is exactly '/reader', render absolutely nothing
  if (pathname === '/reader') {
      return null;
  }
  
  // Otherwise, render the header/footer normally
  return <>{children}</>;
}