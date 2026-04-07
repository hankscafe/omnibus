// src/app/login/reset/page.tsx
"use client"

import { useState, Suspense } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert" 
import { Loader2, Key, AlertTriangle, CheckCircle2 } from "lucide-react" 
import Image from "next/image"
import { OmnibusLogo } from "@/components/omnibus-logo"

function ResetPasswordContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get('token')

  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (password !== confirmPassword) {
        setErrorMsg("Passwords do not match.")
        return
    }

    setLoading(true)
    setErrorMsg(null)

    try {
        const res = await fetch('/api/auth/reset-password/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, password })
        })
        const data = await res.json()
        
        if (res.ok && data.success) {
            setSuccessMsg("Password successfully reset! Redirecting to login...")
            setTimeout(() => {
                router.push('/login')
            }, 2000)
        } else {
            setErrorMsg(data.error || "An error occurred.")
        }
    } catch (e) {
        setErrorMsg("Network error occurred.")
    } finally {
        setLoading(false)
    }
  }

  if (!token) {
      return (
          <Card className="relative z-10 w-full max-w-sm shrink-0 bg-card text-card-foreground border border-border rounded-xl shadow-lg overflow-hidden transition-all duration-300">
              <CardContent className="pt-6 text-center text-muted-foreground font-semibold">
                  Invalid or missing reset token.
              </CardContent>
          </Card>
      )
  }

  return (
    <Card className="relative z-10 w-full max-w-sm shrink-0 bg-card text-card-foreground border border-border rounded-xl shadow-lg overflow-hidden transition-all duration-300">
        <CardHeader className="pb-4 relative z-10 border-b border-border">
          <CardTitle className="flex items-center justify-center gap-2 text-xl font-bold text-foreground leading-tight">
            <Key className="w-5 h-5 text-primary" /> Set New Password
          </CardTitle>
        </CardHeader>
        <CardContent className="relative z-10 pt-6">
          <form onSubmit={handleReset} className="space-y-4">
              <div className="space-y-2">
                  <Label htmlFor="password" title="Required" className="font-semibold text-xs text-foreground">New Password</Label>
                  <Input 
                    id="password"
                    type="password" 
                    placeholder="Enter new password..."  
                    value={password} 
                    onChange={(e) => setPassword(e.target.value)} 
                    className="bg-background border-input rounded-md h-12 sm:h-10 text-base sm:text-sm focus-visible:ring-primary transition-colors" 
                    required
                  />
                  <p className="text-[10px] text-muted-foreground">Min 12 chars. Must include uppercase, lowercase, number, and symbol.</p>
              </div>
              <div className="space-y-2">
                  <Label htmlFor="confirmPassword" title="Required" className="font-semibold text-xs text-foreground">Confirm Password</Label>
                  <Input 
                    id="confirmPassword"
                    type="password" 
                    placeholder="Confirm new password..."  
                    value={confirmPassword} 
                    onChange={(e) => setConfirmPassword(e.target.value)} 
                    className="bg-background border-input rounded-md h-12 sm:h-10 text-base sm:text-sm focus-visible:ring-primary transition-colors" 
                    required
                  />
              </div>

              {errorMsg && (
                <Alert variant="destructive" className="py-2 bg-destructive/10 border-destructive/20 text-destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-xs font-semibold ml-2 leading-tight">
                    {errorMsg}
                  </AlertDescription>
                </Alert>
              )}

              {successMsg && (
                <Alert className="py-2 bg-green-500/10 border-green-500/20 text-green-600 dark:text-green-400">
                  <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                  <AlertDescription className="text-xs font-semibold ml-2 leading-tight">
                    {successMsg}
                  </AlertDescription>
                </Alert>
              )}

              <Button type="submit" className="w-full font-bold h-12 sm:h-11 mt-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-md transition-colors" disabled={loading}>
                  {loading ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <Key className="w-5 h-5 mr-2" />}
                  Reset Password
              </Button>
          </form>
        </CardContent>
    </Card>
  )
}

export default function ResetPasswordPage() {
  return (
    <div suppressHydrationWarning className="fixed inset-0 w-full h-full flex flex-col items-center p-4 bg-background text-foreground overflow-hidden transition-colors duration-300">
      <div className="absolute inset-0 opacity-[0.05] pointer-events-none grayscale dark:invert z-0">
          <Image src="/images/omnibus-branding.jpg" alt="Texture" fill className="object-cover" unoptimized />
      </div>
      <div className="relative z-10 flex-1" />
      <div className="relative z-10 w-full max-w-[800px] px-4 shrink flex justify-center min-h-0">
        <OmnibusLogo className="w-full max-w-[600px] h-auto max-h-[40vh] text-foreground drop-shadow-xl transition-colors duration-300" />
      </div>
      <div className="relative z-10 flex-1 min-h-[2rem]" />
      
      <Suspense fallback={<Loader2 className="w-8 h-8 animate-spin text-primary" />}>
          <ResetPasswordContent />
      </Suspense>
      
      <div className="relative z-10 flex-[2]" />
    </div>
  )
}