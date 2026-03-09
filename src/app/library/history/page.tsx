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
    <div className="container mx-auto py-10 px-6 transition-colors duration-300">
        <title>Omnibus - Reading History</title>
      <div className="flex items-center gap-4 mb-8">
        <Button variant="ghost" size="icon" onClick={() => router.back()} className="hover:bg-muted text-foreground">
            <ChevronLeft className="w-6 h-6" />
        </Button>
        <h1 className="text-3xl font-bold flex items-center gap-3 text-foreground">
            <History className="w-8 h-8 text-primary" /> Reading History
        </h1>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-6">
            {[1,2,3,4,5,6].map(i => <div key={i} className="aspect-[2/3] bg-muted animate-pulse rounded-xl border border-border" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-20 border-2 border-dashed border-border bg-muted/30 rounded-xl transition-colors duration-300">
            <p className="text-muted-foreground text-lg">You haven't started any comics yet!</p>
            <Button className="mt-4 font-bold bg-primary hover:bg-primary/90 text-primary-foreground" asChild><Link href="/">Go Discover</Link></Button>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-6">
            {items.map((item) => (
                <div 
                    key={item.id} 
                    className="group space-y-2 cursor-pointer" 
                    onClick={() => router.push(`/reader?path=${encodeURIComponent(item.filePath)}&series=${encodeURIComponent(item.seriesPath)}`)}
                >
                    <div className="relative aspect-[2/3] rounded-xl overflow-hidden border border-border shadow-sm bg-muted transition-all group-hover:shadow-md group-hover:scale-[1.02] group-hover:ring-2 group-hover:ring-primary">
                        <img src={item.seriesCoverUrl} className="w-full h-full object-cover" alt="" />
                        
                        {/* Gradient for progress bar visibility */}
                        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent z-10 pointer-events-none group-hover:opacity-0 transition-opacity" />

                        {/* Hover action overlay */}
                        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center p-4 z-20">
                            <Button 
                                size="sm" 
                                className="w-full font-bold bg-primary hover:bg-primary/90 text-primary-foreground border-0 shadow-lg" 
                                onClick={(e) => { 
                                    e.stopPropagation(); 
                                    router.push(`/reader?path=${encodeURIComponent(item.filePath)}&series=${encodeURIComponent(item.seriesPath)}`); 
                                }}
                            >
                                <BookOpen className="w-4 h-4 mr-2" /> {item.isCompleted ? "Re-read" : "Resume"}
                            </Button>
                        </div>
                        
                        {/* Floating Progress Bar */}
                        <div className="absolute bottom-0 left-0 w-full p-2 z-20 group-hover:opacity-0 transition-opacity pointer-events-none">
                            <div className="flex justify-end mb-1">
                                <p className="text-white/90 text-[10px] font-mono drop-shadow-md">{item.percentage}%</p>
                            </div>
                            <div className="w-full bg-white/30 h-1.5 rounded-full overflow-hidden backdrop-blur-sm">
                                <div className="bg-primary h-full transition-all duration-500 shadow-sm shadow-primary/50" style={{ width: `${item.percentage}%` }} />
                            </div>
                        </div>
                    </div>
                    <div className="px-0.5">
                        <h3 className="text-sm font-bold truncate text-foreground group-hover:text-primary transition-colors">{item.seriesName}</h3>
                        <p className="text-xs text-muted-foreground">Issue #{item.issueNumber}</p>
                    </div>
                </div>
            ))}
        </div>
      )}
    </div>
  );
}