"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Library, Image as ImageIcon, ArrowRight } from "lucide-react"; 
import { Button } from "@/components/ui/button";
import Link from "next/link"; 

export function RecentlyAdded() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    fetch('/api/library/recent')
      .then(res => res.json())
      .then(data => {
        if (data.items) setItems(data.items);
      })
      .catch(err => console.error("Failed to fetch recent series:", err))
      .finally(() => setLoading(false));
  }, []);

  if (loading || items.length === 0) return null;

  return (
    <div className="space-y-4 pt-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold tracking-tight text-foreground">Recently Added</h2>
        <Button asChild variant="outline" size="sm" className="border-primary/50 text-primary hover:bg-primary/10 group font-bold hidden sm:flex">
            <Link href="/library">
                View Library <ArrowRight className="w-4 h-4 ml-2 transition-transform group-hover:translate-x-1" />
            </Link>
        </Button>
      </div>
      
      <div className="flex overflow-x-auto gap-4 pb-6 pt-4 px-2 snap-x no-scrollbar -mx-2">
        {items.map((item) => (
            <div 
              key={item.id} 
              className="group relative flex-none w-[calc(50%-0.5rem)] md:w-[calc(25%-0.75rem)] lg:w-[calc(14.285%-0.857rem)] aspect-[2/3] bg-muted rounded-lg overflow-hidden shadow-sm hover:scale-[1.03] transition-all cursor-pointer border border-border snap-start"
              onClick={() => router.push(`/library/series?path=${encodeURIComponent(item.path)}`)}
            >
              {item.coverUrl ? (
                  <img src={item.coverUrl} alt={item.name} className="object-cover w-full h-full" />
              ) : (
                  <div className="w-full h-full flex items-center justify-center">
                      <ImageIcon className="w-8 h-8 text-muted-foreground/50" />
                  </div>
              )}

              <div className="absolute bottom-0 left-0 w-full p-3 bg-gradient-to-t from-black/90 via-black/60 to-transparent z-10 group-hover:opacity-0 transition-opacity duration-300 pointer-events-none">
                  <div className="flex flex-col mb-1.5">
                      <p className="text-white font-bold text-xs truncate drop-shadow-md">{item.name}</p>
                      <p className="text-white/80 text-[10px] font-medium drop-shadow-md mt-0.5">
                          {item.issueCount} {item.issueCount === 1 ? 'Issue' : 'Issues'}
                      </p>
                  </div>
              </div>

              <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/60 to-black/20 opacity-0 group-hover:opacity-100 transition-opacity duration-300 hidden sm:flex flex-col justify-end p-4 text-center gap-2 z-20">
                  <h3 className="text-white font-bold text-sm line-clamp-2 drop-shadow-md">{item.name}</h3>
                  <p className="text-white/80 text-xs mb-2 drop-shadow-md">{item.year || '????'}</p>
                  
                  <Button 
                      size="sm" 
                      className="w-full font-bold bg-primary hover:bg-primary/90 text-primary-foreground shadow-md border-0" 
                      onClick={(e) => {
                          e.stopPropagation();
                          router.push(`/library/series?path=${encodeURIComponent(item.path)}`);
                      }}
                  >
                      <Library className="w-3 h-3 mr-2" /> View Series
                  </Button>
              </div>
            </div>
        ))}
      </div>

      <div className="sm:hidden pt-2">
        <Button asChild variant="outline" className="w-full border-primary/50 text-primary hover:bg-primary/10 group font-bold">
            <Link href="/library">
                View Library <ArrowRight className="w-4 h-4 ml-2 transition-transform group-hover:translate-x-1" />
            </Link>
        </Button>
      </div>
    </div>
  );
}