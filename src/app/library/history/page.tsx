"use client";

import { useEffect, useState } from "react";
import { BookOpen, History, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function HistoryPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    fetch('/api/progress/history')
      .then(res => res.json())
      .then(data => setItems(data.items || []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="container mx-auto py-10 px-6">
        <title>Omnibus - Reading History</title> {/* Add this line */}
      <div className="flex items-center gap-4 mb-8">
        <Button variant="ghost" size="icon" onClick={() => router.back()}>
            <ChevronLeft className="w-6 h-6" />
        </Button>
        <h1 className="text-3xl font-bold flex items-center gap-3">
            <History className="w-8 h-8 text-blue-500" /> Reading History
        </h1>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-6">
            {[1,2,3,4,5,6].map(i => <div key={i} className="aspect-[2/3] bg-slate-200 animate-pulse rounded-xl" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-20 border-2 border-dashed rounded-xl">
            <p className="text-muted-foreground text-lg">You haven't started any comics yet!</p>
            <Button className="mt-4" asChild><Link href="/">Go Discover</Link></Button>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-6">
            {items.map((item) => (
                <div key={item.id} className="group space-y-2">
                    <div className="relative aspect-[2/3] rounded-xl overflow-hidden border dark:border-slate-800 shadow-sm bg-slate-100 dark:bg-slate-900">
                        <img src={item.seriesCoverUrl} className="w-full h-full object-cover" alt="" />
                        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center p-4">
                            <Button size="sm" className="w-full bg-purple-600" onClick={() => router.push(`/reader?path=${encodeURIComponent(item.filePath)}&series=${encodeURIComponent(item.seriesPath)}`)}>
                                <BookOpen className="w-4 h-4 mr-2" /> {item.isCompleted ? "Re-read" : "Resume"}
                            </Button>
                        </div>
                        <div className="absolute bottom-0 left-0 w-full h-1.5 bg-neutral-800">
                            <div className="bg-blue-500 h-full transition-all" style={{ width: `${item.percentage}%` }} />
                        </div>
                    </div>
                    <div>
                        <h3 className="text-sm font-bold truncate">{item.seriesName}</h3>
                        <p className="text-xs text-muted-foreground">Issue #{item.issueNumber} • {item.percentage}%</p>
                    </div>
                </div>
            ))}
        </div>
      )}
    </div>
  );
}