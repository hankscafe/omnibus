// src/components/tier-badge.tsx
//
// Shared colored permission-tier badge. Derives the tier from a user's permission flags via
// tierFromUser (Admin / Hero / Vigilante / Sidekick / Civilian / Custom) and renders it with a
// tier-specific color. Used in the admin Users table, the header account menu, and the profile page.
import { Badge } from "@/components/ui/badge";
import { tierFromUser } from "@/lib/permission-tiers";
import { cn } from "@/lib/utils";

export const TIER_BADGE_CLASS: Record<string, string> = {
  Admin: "bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-800",
  Hero: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800",
  Vigilante: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800",
  Sidekick: "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800",
  Civilian: "bg-muted text-muted-foreground border-border",
  Custom: "bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-800",
};

export interface TierUser {
  role?: string | null;
  canRequest?: boolean | null;
  autoApproveRequests?: boolean | null;
  canDownload?: boolean | null;
  canCreateGlobalLists?: boolean | null;
}

export function TierBadge({ user, className }: { user: TierUser; className?: string }) {
  const tier = tierFromUser(user);
  return (
    <Badge variant="outline" className={cn("text-[10px] font-bold", TIER_BADGE_CLASS[tier], className)}>
      {tier}
    </Badge>
  );
}
