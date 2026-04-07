// src/app/login/page.tsx
"use client"

import { useState, useEffect } from "react"
import { signIn, getProviders } from "next-auth/react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert" 
import { useToast } from "@/components/ui/use-toast"
import { Loader2, LogIn, ShieldCheck, Fingerprint, UserPlus, AlertTriangle, CheckCircle2, Mail } from "lucide-react" 
import Image from "next/image"
import { OmnibusLogo } from "@/components/omnibus-logo"
import packageJson from "../../../package.json"
import { Logger } from "@/lib/logger"
import { getErrorMessage } from "@/lib/utils/error"

export default function LoginPage() {
  const router = useRouter()
  const { toast } = useToast()
  
  // UI State
  const [view, setView] = useState<'login' | 'register' | 'forgot'>('login')
  const [loading, setLoading] = useState(false)
  const [ssoLoading, setSsoLoading] = useState(false)
  const [ssoProvider, setSsoProvider] = useState<boolean>(false)
  
  // 2FA State
  const [showTwoFactor, setShowTwoFactor] = useState(false)
  const [totpCode, setTotpCode] = useState("")

  // Message States
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  // Form State
  const [username, setUsername] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")

  useEffect(() => {
    fetch('/api/setup/check')
      .then(res => res.json())
      .then(data => {
          if (data.requiresSetup) router.push('/setup');
      })
      .catch(err => Logger.log(`Setup check failed: ${getErrorMessage(err)}`, 'error'));

    getProviders().then(prov => {
        if (prov?.oidc) setSsoProvider(true);
    });

    const params = new URLSearchParams(window.location.search);
    if (params.get('error')) {
        setErrorMsg("Authentication failed or account pending approval.");
        window.history.replaceState({}, '', '/login'); 
    }
  }, [router])

  const toggleView = (target: 'login' | 'register' | 'forgot') => {
      setView(target);
      setUsername("");
      setEmail("");
      setPassword("");
      setConfirmPassword("");
      setShowTwoFactor(false);
      setTotpCode("");
      setErrorMsg(null);
      setSuccessMsg(null);
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setErrorMsg(null)
    setSuccessMsg(null)

    try {
      const res = await signIn("credentials", { 
          username, 
          password, 
          totpCode: showTwoFactor ? totpCode : "",
          redirect: false 
      })
      
      if (res?.error) {
        if (res.error === "2FA_REQUIRED") {
            setShowTwoFactor(true);
            setLoading(false);
            return;
        }
        let message = res.error;
        if (message === "CredentialsSignin") message = "Invalid username or password.";
        setErrorMsg(message);
      } else {
        router.refresh();
        router.push("/");
      }
    } catch (error) {
      setErrorMsg("Connection to database failed.")
    } finally {
      setLoading(false)
    }
  }

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    setErrorMsg(null)
    setSuccessMsg(null)

    if (password !== confirmPassword) {
      setErrorMsg("Passwords do not match.")
      return
    }
    
    setLoading(true)
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password })
      })
      
      const data = await res.json()
      
      if (res.ok && data.success) {
        setSuccessMsg(data.message)
        toggleView('login')
      } else {
        setErrorMsg(data.error || "Registration failed.")
      }
    } catch (error) {
      setErrorMsg("Connection to database failed.")
    } finally {
      setLoading(false)
    }
  }

  const handleForgotPassword = async (e: React.FormEvent) => {
      e.preventDefault()
      setLoading(true)
      setErrorMsg(null)
      setSuccessMsg(null)

      try {
          const res = await fetch('/api/auth/reset-password', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email })
          })
          const data = await res.json()
          if (res.ok) {
              setSuccessMsg("If an account exists, a password reset link has been sent.")
              setEmail("")
          } else {
              setErrorMsg(data.error || "An error occurred.")
          }
      } catch (error) {
          setErrorMsg("Connection failed.")
      } finally {
          setLoading(false)
      }
  }

  const handleSsoLogin = () => {
      setSsoLoading(true);
      signIn('oidc');
  }

  return (
    <div suppressHydrationWarning className="fixed inset-0 w-full h-full flex flex-col items-center p-4 bg-background text-foreground overflow-hidden transition-colors duration-300">
      
      <div className="absolute inset-0 opacity-[0.05] pointer-events-none grayscale dark:invert z-0">
          <Image src="/images/omnibus-branding.jpg" alt="Texture" fill className="object-cover" unoptimized />
      </div>

      <div className="relative z-10 flex-1" />

      <div className="relative z-10 w-full max-w-[800px] px-4 shrink animate-in fade-in slide-in-from-top-4 duration-1000 flex justify-center min-h-0">
        <OmnibusLogo className="w-full max-w-[600px] h-auto max-h-[40vh] text-foreground drop-shadow-xl transition-colors duration-300" />
      </div>

      <div className="relative z-10 flex-1 min-h-[2rem]" />

      <Card className="relative z-10 w-full max-w-sm shrink-0 bg-card text-card-foreground border border-border rounded-xl shadow-lg overflow-hidden transition-all duration-300">
        <CardHeader className="pb-4 relative z-10 border-b border-border">
          <CardTitle className="flex items-center justify-center gap-2 text-xl font-bold text-foreground leading-tight">
            {view === 'register' ? (
                <><UserPlus className="w-5 h-5 text-primary" /> Create Account</>
            ) : view === 'forgot' ? (
                <><Mail className="w-5 h-5 text-primary" /> Reset Password</>
            ) : showTwoFactor ? (
                <><ShieldCheck className="w-5 h-5 text-primary" /> Two-Factor Auth</>
            ) : (
                <><ShieldCheck className="w-5 h-5 text-primary" /> Login Required</>
            )}
          </CardTitle>
        </CardHeader>
        
        <CardContent className="relative z-10 pt-6">
          <form suppressHydrationWarning onSubmit={view === 'register' ? handleRegister : view === 'forgot' ? handleForgotPassword : handleLogin} className="space-y-4 animate-in fade-in zoom-in-95 duration-300">
            
            {showTwoFactor ? (
              <div className="space-y-2 animate-in slide-in-from-right-4">
                <Label htmlFor="totpCode" className="font-semibold text-xs text-foreground">Authenticator Code</Label>
                <Input 
                  id="totpCode" 
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  placeholder="Enter 6-digit code..." 
                  value={totpCode} 
                  onChange={(e) => setTotpCode(e.target.value)} 
                  className="bg-background border-input rounded-md h-12 sm:h-10 text-center tracking-widest text-2xl font-mono focus-visible:ring-primary transition-colors" 
                  autoComplete="one-time-code"
                  required
                  autoFocus
                />
              </div>
            ) : view === 'forgot' ? (
              <div className="space-y-2 animate-in slide-in-from-right-4">
                  <Label htmlFor="email" className="font-semibold text-xs text-foreground">Account Email Address</Label>
                  <Input 
                      id="email" 
                      type="email"
                      placeholder="Enter email address..." 
                      value={email} 
                      onChange={(e) => setEmail(e.target.value)} 
                      className="bg-background border-input rounded-md h-12 sm:h-10 text-base sm:text-sm focus-visible:ring-primary transition-colors" 
                      required
                      autoFocus
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">We will send a password reset link to this email address.</p>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="username" className="font-semibold text-xs text-foreground">
                    {view === 'register' ? "Username" : "Username / Email"}
                  </Label>
                  <Input 
                    id="username" 
                    suppressHydrationWarning
                    placeholder="Enter username..." 
                    value={username} 
                    onChange={(e) => setUsername(e.target.value)} 
                    className="bg-background border-input rounded-md h-12 sm:h-10 text-base sm:text-sm focus-visible:ring-primary transition-colors" 
                    autoCapitalize="none"
                    autoCorrect="off"
                    autoComplete={view === 'register' ? "off" : "username"}
                    required
                  />
                </div>
                
                {view === 'register' && (
                  <div className="space-y-2">
                    <Label htmlFor="email" className="font-semibold text-xs text-foreground">Email Address</Label>
                    <Input 
                      id="email" 
                      suppressHydrationWarning
                      type="email"
                      placeholder="Enter email address..." 
                      value={email} 
                      onChange={(e) => setEmail(e.target.value)} 
                      className="bg-background border-input rounded-md h-12 sm:h-10 text-base sm:text-sm focus-visible:ring-primary transition-colors" 
                      autoCapitalize="none"
                      autoCorrect="off"
                      autoComplete="email"
                      required
                    />
                  </div>
                )}

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                      <Label htmlFor="password" title="Required" className="font-semibold text-xs text-foreground">Password</Label>
                      {view === 'login' && (
                          <Button variant="link" type="button" onClick={() => toggleView('forgot')} className="h-auto p-0 text-[10px] text-muted-foreground hover:text-primary">
                              Forgot password?
                          </Button>
                      )}
                  </div>
                  <Input 
                    id="password"
                    suppressHydrationWarning
                    type="password" 
                    placeholder="Enter password..."  
                    value={password} 
                    onChange={(e) => setPassword(e.target.value)} 
                    className="bg-background border-input rounded-md h-12 sm:h-10 text-base sm:text-sm focus-visible:ring-primary transition-colors" 
                    autoComplete={view === 'register' ? "new-password" : "current-password"}
                    required
                  />
                  {view === 'register' && <p className="text-[10px] text-muted-foreground">Min 12 chars. Must include uppercase, lowercase, number, and symbol.</p>}
                </div>

                {view === 'register' && (
                  <div className="space-y-2">
                    <Label htmlFor="confirmPassword" title="Required" className="font-semibold text-xs text-foreground">Confirm Password</Label>
                    <Input 
                      id="confirmPassword"
                      suppressHydrationWarning
                      type="password" 
                      placeholder="Confirm your password..."  
                      value={confirmPassword} 
                      onChange={(e) => setConfirmPassword(e.target.value)} 
                      className="bg-background border-input rounded-md h-12 sm:h-10 text-base sm:text-sm focus-visible:ring-primary transition-colors" 
                      autoComplete="new-password"
                      required
                    />
                  </div>
                )}
              </>
            )}

            {/* INLINE ERROR/SUCCESS MESSAGES */}
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

            <Button type="submit" className="w-full font-bold h-12 sm:h-11 mt-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-md transition-colors" disabled={loading || ssoLoading}>
              {loading ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : (view === 'register' ? <UserPlus className="w-5 h-5 mr-2" /> : view === 'forgot' ? <Mail className="w-5 h-5 mr-2" /> : <LogIn className="w-5 h-5 mr-2" />)}
              {view === 'register' ? "Register Account" : view === 'forgot' ? "Send Reset Link" : showTwoFactor ? "Verify Code" : "Log Into Omnibus"}
            </Button>
          </form>

          {showTwoFactor && (
            <div className="text-center mt-4 flex flex-col gap-2">
                <Button variant="link" type="button" onClick={() => toggleView('login')} className="text-xs text-muted-foreground hover:text-primary h-auto p-0">
                    &larr; Back to Password
                </Button>
            </div>
          )}

          {!showTwoFactor && (
            <div className="text-center mt-4 flex flex-col gap-2">
                {view === 'forgot' ? (
                    <Button variant="link" type="button" onClick={() => toggleView('login')} className="text-xs text-muted-foreground hover:text-primary h-auto p-0">
                        &larr; Back to Login
                    </Button>
                ) : (
                    <Button variant="link" type="button" onClick={() => toggleView(view === 'register' ? 'login' : 'register')} className="text-xs text-muted-foreground hover:text-primary h-auto p-0">
                        {view === 'register' ? "Already have an account? Log in." : "Need an account? Register here."}
                    </Button>
                )}
            </div>
          )}

          {ssoProvider && !showTwoFactor && view !== 'forgot' && (
              <div className="mt-6">
                  <div className="relative mb-6">
                      <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-border" /></div>
                      <div className="relative flex justify-center text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                          <span className="bg-card px-3 transition-colors duration-300">Or Continue With</span>
                      </div>
                  </div>
                  
                  <Button type="button" variant="outline" className="w-full font-bold h-12 sm:h-11 border-border hover:bg-muted text-foreground transition-all" onClick={handleSsoLogin} disabled={loading || ssoLoading}>
                      {ssoLoading ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <Fingerprint className="w-5 h-5 mr-2 text-primary" />}
                      Single Sign-On (SSO)
                  </Button>
                  
                  {view === 'register' && (
                      <p className="text-[10px] text-center text-muted-foreground mt-3">
                          SSO users do not need to register. You can log in directly using your provider.
                      </p>
                  )}
              </div>
          )}
        </CardContent>
        
        <CardFooter className="flex justify-between items-center pb-6 pt-2 relative z-10">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Build: v{packageJson.version}
          </p>
          <div className="flex gap-1.5">
            <div className="w-2 h-2 bg-primary rounded-full animate-pulse" />
            <div className="w-2 h-2 bg-muted rounded-full" />
          </div>
        </CardFooter>
      </Card>

      <div className="relative z-10 flex-[2]" />
    </div>
  )
}