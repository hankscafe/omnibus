import { cn } from "@/lib/utils"

export function OmnibusLogo({ className }: { className?: string }) {
  return (
    <svg 
      xmlns="http://www.w3.org/2000/svg" 
      viewBox="0 0 800 160" 
      className={cn("text-current", className)}
    >
      <defs>
        {/* The mask uses white to reveal, and black to hide (cut) */}
        <mask id="slice-mask">
          <rect x="0" y="0" width="100%" height="100%" fill="white" />
          {/* Shifted y down to 71 to hit the exact center of the font's cap-height */}
          <rect x="0" y="67" width="100%" height="6" fill="black" />
        </mask>
      </defs>

      <g fill="currentColor">
        {/* Main Title */}
        <text 
          x="400" y="110" 
          fontFamily="Arial, sans-serif" 
          fontSize="110" 
          fontWeight="800" 
          textAnchor="middle" 
          letterSpacing="12"
          mask="url(#slice-mask)"
        >
          OMNIBUS
        </text>

        {/* Tagline */}
        <text 
          x="400" y="145" 
          fontFamily="Arial, sans-serif" 
          fontSize="16" 
          fontWeight="bold" 
          textAnchor="middle" 
          letterSpacing="6"
          className="opacity-90"
        >
          YOUR UNIVERSE. ORGANIZED.
        </text>
      </g>
    </svg>
  )
}