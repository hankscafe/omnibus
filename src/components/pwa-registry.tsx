"use client";

import { useEffect } from "react";

export function PwaRegistry() {
  useEffect(() => {
    // Only register the service worker in production builds
    if (process.env.NODE_ENV !== 'production' || !("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js").then(
        () => {
          console.log("PWA Service Worker registered.");
        },
        (err) => {
          console.error("PWA Service Worker registration failed: ", err);
        }
      );
    };

    // This effect runs after hydration, and by then the page has usually finished loading - a "load"
    // listener added now would never run (until v1.4.11-beta.036 the worker was in practice never
    // registered). Register at once if the page has loaded; otherwise wait for "load", so the worker's
    // install doesn't compete with the page's own requests.
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
