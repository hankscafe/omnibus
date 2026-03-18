"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, Image as ImageIcon, X, ArrowRight } from "lucide-react"; 
import { Button } from "@/components/ui/button";
import Link from "next/link"; 

function DynamicCover({ seriesCvId, issueNumber, fallbackUrl, altName }: { seriesCvId: number | null, issueNumber: string, fallbackUrl: string, altName: string }) {
    const [cover, setCover] = useState<string | null>(fallbackUrl);
    
    useEffect(() => {
        if (!seriesCvId) return;
        const cacheKey = `cv-vol-${seriesCvId}`;
        const cached = sessionStorage.getItem(cacheKey);
        
        const extractCover = (issues: any[]) => {
            const parsedNum = parseFloat(issueNumber);
            const matched = issues.find(cv => parseFloat(cv.issueNumber || cv.issue_number) === parsedNum);
            if (matched && matched.image && typeof matched.image === 'string') {
                setCover(matched.image);
            }
        };
        
        if (cached) {
            extractCover(JSON.parse(cached));
        } else {
            fetch(`/api/series-issues?volumeId=${seriesCvId}`)
                .then(async (res) => {
                    if (!res.ok) throw new Error(`API returned ${res.status}`);
                    return res.json();
                })
                .then(data => {
                    const issuesArray = data.results || data.issues || (Array.isArray(data) ? data : []);
                    if (issuesArray.length > 0) {
                        sessionStorage.setItem(cacheKey, JSON.stringify(issuesArray));
                        extractCover(issuesArray);
                    }
                })
                .catch((err) => console.error(`Fetch failed for CV ID ${seriesCvId}:`, err));
        }
    }, [seriesCvId, issueNumber]);

    return cover ? (
        <img src={cover} alt={altName} className="object-cover w-full h-full" onError={(e) => (e.currentTarget.src = fallbackUrl)} />
    ) : (
        <div className="w-full h-full flex items-center justify-center">
            <ImageIcon className="w-8 h-8 text-muted-foreground/50" />
        </div>
    );
}

export function ContinueReading() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    fetch('/api/progress/recent')
      .then(res => res.json())
      .then(data => {
        if (data.items) setItems(data.items);
      })
      .catch(err => console.error("Failed to fetch recent progress:", err))
      .finally(() => setLoading(false));
  }, []);

  const handleMarkUnread = async (e: React.MouseEvent, progressId: number | string) => {
      e.stopPropagation();
      setItems(prev => prev.filter(item => item.id !== progressId));
      try {
          await fetch('/api/progress/unread', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ progressId })
          });
      } catch (err) {
          console.error("Failed to mark unread:", err);
      }
  };

  if (loading || items.length === 0) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold tracking-tight text-foreground">Jump Back In</h2>
        <Button asChild variant="outline" size="sm" className="border-primary/50 text-primary hover:bg-primary/10 group font-bold hidden sm:flex">
            <Link href="/library/history">
                View History <ArrowRight className="w-4 h-4 ml-2 transition-transform group-hover:translate-x-1" />
            </Link>
        </Button>
      </div>
      
      <div className="flex overflow-x-auto gap-4 pb-6 pt-4 px-2 snap-x no-scrollbar -mx-2">
        {items.map((item) => (
            <div 
              key={item.id} 
              className="group relative flex-none w-[calc(50%-0.5rem)] md:w-[calc(25%-0.75rem)] lg:w-[calc(14.285%-0.857rem)] aspect-[2/3] bg-muted rounded-lg overflow-hidden shadow-sm hover:scale-[1.03] transition-all cursor-pointer border border-border snap-start"
              onClick={() => router.push(`/reader?path=${encodeURIComponent(item.filePath)}&series=${encodeURIComponent(item.seriesPath)}`)}
            >
              <DynamicCover 
                  seriesCvId={item.seriesCvId} 
                  issueNumber={item.issueNumber} 
                  fallbackUrl={item.seriesCoverUrl} 
                  altName={item.seriesName}
              />

              <div className="absolute bottom-0 left-0 w-full p-3 bg-gradient-to-t from-black/90 via-black/60 to-transparent z-10 group-hover:opacity-0 transition-opacity duration-300 pointer-events-none">
                  <div className="flex justify-between items-end mb-1.5">
                      <p className="text-white font-bold text-xs truncate max-w-[70%] drop-shadow-md">{item.seriesName}</p>
                      <p className="text-white/90 text-[10px] font-mono drop-shadow-md">{item.percentage}%</p>
                  </div>
                  <div className="w-full bg-white/30 h-1.5 rounded-full overflow-hidden backdrop-blur-sm">
                      <div 
                          className="bg-primary h-full rounded-full transition-all duration-500 shadow-sm shadow-primary/50" 
                          style={{ width: `${item.percentage}%` }}
                      />
                  </div>
              </div>

              <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/60 to-black/20 opacity-0 group-hover:opacity-100 transition-opacity duration-300 hidden sm:flex flex-col justify-end p-4 text-center gap-2 z-20">
                  <h3 className="text-white font-bold text-sm line-clamp-2 drop-shadow-md">{item.seriesName}</h3>
                  <p className="text-white/80 text-xs mb-1 drop-shadow-md">Issue #{item.issueNumber}</p>
                  
                  <Button 
                      size="sm" 
                      className="w-full font-bold bg-primary hover:bg-primary/90 text-primary-foreground shadow-md border-0" 
                      onClick={(e) => {
                          e.stopPropagation();
                          router.push(`/reader?path=${encodeURIComponent(item.filePath)}&series=${encodeURIComponent(item.seriesPath)}`);
                      }}
                  >
                      <BookOpen className="w-3 h-3 mr-2" /> Resume
                  </Button>

                  <Button 
                      variant="secondary" 
                      size="sm" 
                      className="w-full font-bold shadow-md" 
                      onClick={(e) => handleMarkUnread(e, item.id)}
                  >
                      <X className="w-3 h-3 mr-1" /> Mark Unread
                  </Button>
              </div>
            </div>
        ))}
      </div>
      
      <div className="sm:hidden pt-2">
        <Button asChild variant="outline" className="w-full border-primary/50 text-primary hover:bg-primary/10 group font-bold">
            <Link href="/library/history">
                View History <ArrowRight className="w-4 h-4 ml-2 transition-transform group-hover:translate-x-1" />
            </Link>
        </Button>
      </div>
    </div>
  );
}