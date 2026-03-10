import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { AuthProvider } from "@/components/AuthProvider";
import { ThemeProvider } from "@/components/ThemeProvider";
import { NavigationWrapper } from "@/components/navigation-wrapper";
import { TitleManager } from "@/components/title-manager";

// --- NEW IMPORTS FOR SERVER-SIDE REDIRECT ---
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Omnibus",
  description: "A self-hosted comic book manager. Your Universe. Organized.",
  icons: {
    icon: '/favicon.ico',
    shortcut: '/favicon.ico',
    apple: '/favicon.ico',
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  
  // --- INSTANT SERVER-SIDE SETUP GUARD ---
  const headersList = await headers();
  const pathname = headersList.get("x-pathname") || "";
  
  let requiresSetup = false;

  // Only query the database if they aren't already on the setup page
  if (!pathname.startsWith("/setup")) {
    try {
      const userCount = await prisma.user.count();
      let setupSetting = await prisma.systemSetting.findUnique({
        where: { key: "setup_complete" },
      });

      // Auto-Heal Legacy Databases
      if (userCount > 0 && setupSetting?.value !== "true") {
        setupSetting = await prisma.systemSetting.upsert({
          where: { key: "setup_complete" },
          update: { value: "true" },
          create: { key: "setup_complete", value: "true" },
        });
      }

      if (userCount === 0 || setupSetting?.value !== "true") {
        requiresSetup = true;
      }
    } catch (error) {
      // If the DB connection fails (meaning it's totally fresh/uninitialized), force setup
      requiresSetup = true;
    }
  }

  // If setup is required, redirect IMMEDIATELY at the network level (Zero Flash)
  if (requiresSetup) {
    redirect("/setup");
  }

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* EXACT ANTI-FOUC SCRIPT: Perfectly matches your ThemeProvider & globals.css */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                // 1. Force Custom Color Theme (Symbiote, Krypton, etc.)
                let colorTheme = window.localStorage.getItem('omnibus-color-theme');
                if (colorTheme && colorTheme !== 'default') {
                  document.documentElement.setAttribute('data-theme', colorTheme);
                }

                // 2. Force Dark/Light Mode Base
                let nextTheme = window.localStorage.getItem('theme');
                if (nextTheme === 'dark' || (nextTheme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
                  document.documentElement.classList.add('dark');
                } else {
                  document.documentElement.classList.remove('dark');
                }
              } catch (e) {}
            `,
          }}
        />
      </head>
      <body className={`${inter.className} min-h-screen flex flex-col bg-background text-foreground antialiased`}>
        <AuthProvider>
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
            
            <TitleManager />
            
            <NavigationWrapper>
              <SiteHeader />
            </NavigationWrapper>
            
            <main className="flex-1">
              {children}
            </main>

            <NavigationWrapper>
              <SiteFooter />
            </NavigationWrapper>

          </ThemeProvider>
        </AuthProvider>
      </body>
    </html>
  );
}