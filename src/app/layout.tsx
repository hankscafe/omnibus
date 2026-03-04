import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { AuthProvider } from "@/components/AuthProvider";
import { ThemeProvider } from "@/components/ThemeProvider";
import { NavigationWrapper } from "@/components/navigation-wrapper";
import { TitleManager } from "@/components/title-manager";
import { SetupGuard } from "@/components/setup-guard"; // <-- NEW IMPORT

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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.className} min-h-screen flex flex-col bg-background text-foreground antialiased`}>
        <AuthProvider>
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
            
            {/* The global Title Manager enforces tab names */}
            <TitleManager />
            
            {/* The Global Setup Guard */}
            <SetupGuard>
              {/* Logic to hide Header on Login and Reader pages */}
              <NavigationWrapper>
                <SiteHeader />
              </NavigationWrapper>
              
              <main className="flex-1">
                {children}
              </main>

              {/* Logic to hide Footer on Login and Reader pages */}
              <NavigationWrapper>
                <SiteFooter />
              </NavigationWrapper>
            </SetupGuard>

          </ThemeProvider>
        </AuthProvider>
      </body>
    </html>
  );
}