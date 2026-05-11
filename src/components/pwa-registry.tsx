"use client";

import { useEffect } from "react";

export function PwaRegistry() {
  useEffect(() => {
    // Only register the service worker in production builds
    if (process.env.NODE_ENV === 'production' && typeof window !== "undefined" && "serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js").then(
          (registration) => {
            console.log("PWA Service Worker registered.");
          },
          (err) => {
            console.error("PWA Service Worker registration failed: ", err);
          }
        );
      });
    }
  }, []);

  return null;
}