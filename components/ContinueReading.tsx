"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, Image as ImageIcon, X, ArrowRight } from "lucide-react"; 
import { Button } from "@/components/ui/button";
import Link from "next/link"; 

// Sub-component remains unchanged
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
            <ImageIcon className="w-8 h-8 text-slate-300 dark:text-slate-600" />
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
        <h2 className="text-2xl font-bold tracking-tight">Jump Back In</h2>
        <Link 
            href="/library/history" 
            className="group flex items-center gap-1 text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline"
        >
            View History
            <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
        </Link>
      </div>
      
      {/* Added slight padding so the hover scale effect doesn't get clipped on the edges! */}
      <div className="flex overflow-x-auto gap-4 pb-6 pt-4 px-2 snap-x no-scrollbar -mx-2">
        {items.map((item) => (
            <div 
              key={item.id} 
              className="group relative flex-none w-32 sm:w-36 md:w-40 lg:w-44 aspect-[2/3] bg-slate-100 dark:bg-slate-900 rounded-lg overflow-hidden shadow-sm hover:scale-105 transition-all cursor-pointer dark:border dark:border-slate-800 snap-start"
              onClick={() => router.push(`/reader?path=${encodeURIComponent(item.filePath)}&series=${encodeURIComponent(item.seriesPath)}`)}
            >
              <DynamicCover 
                  seriesCvId={item.seriesCvId} 
                  issueNumber={item.issueNumber} 
                  fallbackUrl={item.seriesCoverUrl} 
                  altName={item.seriesName}
              />

              {/* ALWAYS VISIBLE: Progress bar and Title at the bottom (Fades out when hovered) */}
              <div className="absolute bottom-0 left-0 w-full p-3 bg-gradient-to-t from-black/90 via-black/60 to-transparent z-10 group-hover:opacity-0 transition-opacity duration-300 pointer-events-none">
                  <div className="flex justify-between items-end mb-1.5">
                      <p className="text-white font-bold text-xs truncate max-w-[70%] drop-shadow-md">{item.seriesName}</p>
                      <p className="text-white/90 text-[10px] font-mono drop-shadow-md">{item.percentage}%</p>
                  </div>
                  <div className="w-full bg-white/30 h-1.5 rounded-full overflow-hidden backdrop-blur-sm">
                      <div 
                          className="bg-blue-500 h-full rounded-full transition-all duration-500 shadow-[0_0_8px_rgba(59,130,246,0.8)]" 
                          style={{ width: `${item.percentage}%` }}
                      />
                  </div>
              </div>

              {/* HOVER OVERLAY: Matches the ComicGrid style exactly */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/60 to-black/20 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-4 text-center gap-2 z-20">
                  <h3 className="text-white font-bold text-sm line-clamp-2 drop-shadow-md">{item.seriesName}</h3>
                  <p className="text-white/80 text-xs mb-1 drop-shadow-md">Issue #{item.issueNumber}</p>
                  
                  <Button 
                      size="sm" 
                      className="w-full font-bold bg-blue-600 hover:bg-blue-700 text-white shadow-md border-0" 
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
    </div>
  );
}