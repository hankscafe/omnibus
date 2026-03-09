import Link from "next/link"
import { Github } from "lucide-react"

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-background transition-colors duration-300 py-6 md:py-0">
      <div className="container mx-auto flex flex-col items-center justify-between gap-4 md:h-16 md:flex-row px-6">
        <p className="text-center text-sm leading-loose text-muted-foreground md:text-left">
          Developed by <span className="font-bold text-primary">hanks_cafe</span>.
        </p>
        
        <div className="flex items-center gap-6">
            <Link
                href="https://github.com/hankscafe/omnibus/"
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-primary transition-colors"
            >
                <Github className="h-4 w-4" />
                GitHub
            </Link>
            
            <div className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded-md">
                v1.0.0-beta.5
            </div>
        </div>
      </div>
    </footer>
  )
}