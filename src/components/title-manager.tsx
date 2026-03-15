"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

export function TitleManager() {
  const pathname = usePathname();

  useEffect(() => {
    if (!pathname) return;

    let newTitle = "Omnibus";

    // Map your specific routes to their proper titles
    if (pathname === "/") newTitle = "Omnibus - Home";
    else if (pathname.startsWith("/admin/smart-match")) newTitle = "Omnibus - Smart Matcher";
    else if (pathname.startsWith("/admin/settings")) newTitle = "Omnibus - Settings";
    else if (pathname.startsWith("/admin/storage")) newTitle = "Omnibus - Storage";
    else if (pathname.startsWith("/admin/analytics")) newTitle = "Omnibus - Analytics";
    else if (pathname.startsWith("/admin/diagnostics")) newTitle = "Omnibus - Diagnostics";
    else if (pathname.startsWith("/admin/jobs")) newTitle = "Omnibus - Scheduled Jobs";
    else if (pathname.startsWith("/admin/logs")) newTitle = "Omnibus - System Logs";
    else if (pathname.startsWith("/admin/reports")) newTitle = "Omnibus - Issue Reports";
    else if (pathname.startsWith("/admin/trophies")) newTitle = "Omnibus - Trophies";
    else if (pathname.startsWith("/admin/users")) newTitle = "Omnibus - Users";
    else if (pathname.startsWith("/admin/download-clients")) newTitle = "Omnibus - Download Clients";
    else if (pathname.startsWith("/admin/updates")) newTitle = "Omnibus - Updates";
    else if (pathname.startsWith("/admin/api-guide")) newTitle = "Omnibus - API Guide";
    else if (pathname === "/admin") newTitle = "Omnibus - Admin";
    else if (pathname.startsWith("/library/series")) newTitle = "Omnibus - Series";
    else if (pathname.startsWith("/library/history")) newTitle = "Omnibus - Reading History";
    else if (pathname === "/library") newTitle = "Omnibus - Library";
    else if (pathname === "/reading-lists") newTitle = "Omnibus - Reading Lists";
    else if (pathname.startsWith("/requests")) newTitle = "Omnibus - My Requests";
    else if (pathname.startsWith("/reader")) newTitle = "Omnibus - Reader";
    else if (pathname.startsWith("/profile")) newTitle = "Omnibus - Profile";
    else if (pathname.startsWith("/login")) newTitle = "Omnibus - Login";
    

    // 1. Set the title immediately
    document.title = newTitle;

    // 2. Next.js aggressively re-applies root metadata after page load.
    // This MutationObserver watches the <head> and instantly reverts any overwrites by Next.js!
    const observer = new MutationObserver(() => {
      if (document.title !== newTitle) {
        document.title = newTitle;
      }
    });

    observer.observe(document.head, { childList: true, subtree: true, characterData: true });

    return () => observer.disconnect();
  }, [pathname]);

  return null;
}