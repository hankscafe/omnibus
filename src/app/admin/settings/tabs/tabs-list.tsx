// src/app/admin/settings/tabs/tabs-list.tsx
//
// The settings tab bar. Each trigger shows an amber dot while state owned by that tab has
// unsaved changes (dirtyTabs comes from computeDirtyTabs in ./dirty).
"use client"

import { TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SETTINGS_TABS } from "./dirty"

const TRIGGER_CLS = "px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold"

export function SettingsTabsList({ dirtyTabs }: { dirtyTabs: string[] }) {
    return (
        <TabsList className="flex w-full overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] h-auto bg-muted border border-border gap-1 p-1 justify-start lg:justify-center">
            {SETTINGS_TABS.map(t => (
                <TabsTrigger key={t.value} value={t.value} className={TRIGGER_CLS}>
                    {t.label}
                    {dirtyTabs.includes(t.value) && (
                        <span
                            aria-label="Unsaved changes"
                            title="Unsaved changes on this tab"
                            className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0"
                        />
                    )}
                </TabsTrigger>
            ))}
        </TabsList>
    )
}
