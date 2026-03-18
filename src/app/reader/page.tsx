"use client"

import { useState, useEffect, useCallback, useRef, Suspense } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { 
  ChevronLeft, ChevronRight, X, Loader2, Maximize, Minimize, BookOpen, 
  Settings as SettingsIcon, SkipBack, SkipForward, CheckCircle2,
  Paintbrush, LayoutTemplate, MonitorPlay, Zap, ZoomIn, ZoomOut, Search, AlignHorizontalSpaceAround,
  Sun // Added for brightness/contrast icon
} from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"

function ReaderContent() {
  if (typeof document !== 'undefined') {
    document.title = "Omnibus - Reader";
  }

  const searchParams = useSearchParams();
  const router = useRouter();
  const filePath = searchParams.get('path');
  const seriesPath = searchParams.get('series');
  const { toast } = useToast();

  const [pages, setPages] = useState<string[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMarkedRead, setIsMarkedRead] = useState(false);
  
  const [isReadyToSync, setIsReadyToSync] = useState(false);
  
  // UI States
  const [showUI, setShowUI] = useState(false); 
  const [hoverTop, setHoverTop] = useState(false);
  const [hoverBottom, setHoverBottom] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // New Reader Features State
  const [zoomLevel, setZoomLevel] = useState(100);
  const [jumpInput, setJumpInput] = useState("");
  const [isJumping, setIsJumping] = useState(false);

  // Mouse Panning State
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 });
  const [dragDistance, setDragDistance] = useState(0);

  // TOUCH/SWIPE STATE
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const touchEndX = useRef(0);
  const touchEndY = useRef(0);

  // Transient Page Indicator State
  const [showPageToast, setShowPageToast] = useState(false);
  const hideToastTimeout = useRef<NodeJS.Timeout | null>(null);

  // Mouse Idle State (for cursor hiding)
  const [isIdle, setIsIdle] = useState(false);
  const idleTimeout = useRef<NodeJS.Timeout | null>(null);

  // Settings State (Added Brightness & Contrast)
  const [settings, setSettings] = useState({
      readingMode: 'ltr', 
      animateTransitions: 'true', 
      backgroundColor: 'black', 
      scaleType: 'fit-height', 
      pageLayout: 'single',
      spreadGap: 'none',
      brightness: 100,
      contrast: 100
  });

  const [nextIssue, setNextIssue] = useState<{ path: string, name: string } | null>(null);

  const issueName = filePath ? filePath.split(/[\\/]/).pop()?.replace(/\.[^/.]+$/, "") : "Loading...";
  const seriesName = seriesPath ? seriesPath.split(/[\\/]/).pop() : "Comic Reader";

  const getAuthHeaders = useCallback(() => {
    return { 'Content-Type': 'application/json' };
  }, []);

  // Fetch Pages, Context, & Exact Progress
  useEffect(() => {
    if (!filePath) return;
    setLoading(true);
    
    // Reset reader state immediately when navigating to a new issue
    setCurrentIndex(0);
    setIsReadyToSync(false);
    setPages([]);
    
    Promise.all([
      fetch(`/api/reader/pages?path=${encodeURIComponent(filePath)}`).then(res => res.json()),
      fetch(`/api/progress?path=${encodeURIComponent(filePath)}`, { headers: getAuthHeaders() }).then(res => res.json()),
      seriesPath ? fetch(`/api/library/series?path=${encodeURIComponent(seriesPath)}`, { headers: getAuthHeaders() }).then(res => res.json()) : Promise.resolve(null)
    ])
      .then(([pageData, progressData, seriesData]) => {
        if (pageData.error) throw new Error(pageData.error);
        setPages(pageData.pages);

        if (seriesData && seriesData.downloadedIssues) {
            if (seriesData.isManga) setSettings(s => ({ ...s, readingMode: 'rtl' }));
            const sortedIssues = [...seriesData.downloadedIssues].sort((a, b) => (a.parsedNum ?? 0) - (b.parsedNum ?? 0));
            const currentIdx = sortedIssues.findIndex((issue: any) => issue.fullPath === filePath);
            if (currentIdx > -1 && currentIdx < sortedIssues.length - 1) {
                setNextIssue({ path: sortedIssues[currentIdx + 1].fullPath, name: sortedIssues[currentIdx + 1].name });
            } else {
                setNextIssue(null); // Ensure we clear it if it's the last issue
            }
        } else {
            setNextIssue(null);
        }

        // Apply progress for the specific issue we just loaded
        if (progressData && progressData.currentPage > 0 && !progressData.isCompleted) {
            const safePage = Math.min(progressData.currentPage, pageData.pages.length - 1);
            setCurrentIndex(safePage);
        } else {
            setCurrentIndex(0); // Explicitly start at 0 if no progress exists
        }
        
        setIsMarkedRead(progressData?.isCompleted || false);
        setTimeout(() => setIsReadyToSync(true), 500); 
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [filePath, seriesPath, getAuthHeaders]);

  // Sync Progress
  useEffect(() => {
    if (loading || !isReadyToSync || pages.length === 0) return;
    
    const timer = setTimeout(() => {
        fetch('/api/progress', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ filePath, currentPage: currentIndex, totalPages: pages.length })
        });
    }, 1500);

    return () => clearTimeout(timer);
  }, [currentIndex, pages.length, filePath, loading, isReadyToSync, getAuthHeaders]);

  const getStep = useCallback(() => {
    if (settings.pageLayout === 'single' || settings.readingMode === 'webtoon') return 1;
    if (settings.pageLayout === 'double') return 2;
    if (settings.pageLayout === 'double-no-cover') return currentIndex === 0 ? 1 : 2;
    return 1;
  }, [settings.pageLayout, settings.readingMode, currentIndex]);

  useEffect(() => {
      if (!pages.length || !filePath) return;
      const preloadImage = (index: number) => {
          if (index >= pages.length) return;
          const img = new Image();
          img.src = `/api/reader/image?path=${encodeURIComponent(filePath)}&page=${encodeURIComponent(pages[index])}`;
      };
      const step = getStep();
      for (let i = 1; i <= 3; i++) {
          preloadImage(currentIndex + (step * i));
          if (settings.pageLayout.includes('double')) preloadImage(currentIndex + (step * i) + 1);
      }
  }, [currentIndex, pages, filePath, getStep, settings.pageLayout]);

  useEffect(() => {
    const handleMouseMove = () => {
        setIsIdle(false);
        if (idleTimeout.current) clearTimeout(idleTimeout.current);
        idleTimeout.current = setTimeout(() => setIsIdle(true), 2500); 
    };
    idleTimeout.current = setTimeout(() => setIsIdle(true), 2500);
    window.addEventListener('mousemove', handleMouseMove);
    return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        if (idleTimeout.current) clearTimeout(idleTimeout.current);
    };
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  };

  useEffect(() => {
      const handleFullscreenChange = () => setIsFullscreen(!!document.fullscreenElement);
      document.addEventListener('fullscreenchange', handleFullscreenChange);
      return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const triggerPageToast = useCallback(() => {
      setShowPageToast(true);
      if (hideToastTimeout.current) clearTimeout(hideToastTimeout.current);
      hideToastTimeout.current = setTimeout(() => setShowPageToast(false), 1500);
  }, []);

  const nextPage = useCallback(() => {
    const step = getStep();
    if (currentIndex < pages.length - step) {
        setCurrentIndex(prev => prev + step);
        if (!showUI) triggerPageToast();
    } else if (currentIndex < pages.length - 1) {
        setCurrentIndex(pages.length - 1);
        if (!showUI) triggerPageToast();
    } else if (nextIssue && seriesPath) {
        // Force sync the current issue as 100% complete before moving on
        fetch('/api/progress', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ 
                filePath, 
                currentPage: pages.length, 
                totalPages: pages.length 
            })
        }).catch(() => {});

        toast({ title: "Loading Next Issue...", description: nextIssue.name });
        router.replace(`/reader?path=${encodeURIComponent(nextIssue.path)}&series=${encodeURIComponent(seriesPath)}`);
    }
  }, [currentIndex, pages.length, nextIssue, seriesPath, router, toast, getStep, showUI, triggerPageToast, filePath, getAuthHeaders]);

  const prevPage = useCallback(() => {
    if (currentIndex > 0) {
        let step = (settings.pageLayout === 'double') ? 2 : (settings.pageLayout === 'double-no-cover' && currentIndex === 1) ? 1 : 2;
        if (settings.pageLayout === 'single') step = 1;
        setCurrentIndex(prev => Math.max(0, prev - step));
        if (!showUI) triggerPageToast();
    }
  }, [currentIndex, settings.pageLayout, showUI, triggerPageToast]);

  const handlePageJump = (e: React.FormEvent) => {
      e.preventDefault();
      let target = parseInt(jumpInput) - 1;
      if (isNaN(target)) return;
      target = Math.max(0, Math.min(target, pages.length - 1));
      setCurrentIndex(target);
      setIsJumping(false);
      setJumpInput("");
  };

  const toggleReadStatus = async () => {
      const newStatus = !isMarkedRead;
      setIsMarkedRead(newStatus);
      await fetch('/api/progress', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ filePath, currentPage: newStatus ? pages.length : 0, totalPages: pages.length })
      });
      toast({ title: newStatus ? "Marked as Read" : "Marked as Unread" });
  };

  // NATIVE TOUCH GESTURE LOGIC
  const handleTouchStart = (e: React.TouchEvent) => {
      touchStartX.current = e.changedTouches[0].screenX;
      touchStartY.current = e.changedTouches[0].screenY;
      touchEndX.current = e.changedTouches[0].screenX; 
      touchEndY.current = e.changedTouches[0].screenY;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
      touchEndX.current = e.changedTouches[0].screenX;
      touchEndY.current = e.changedTouches[0].screenY;
  };

  const handleTouchEnd = () => {
      if (zoomLevel !== 100 || settings.readingMode === 'webtoon') return; // Don't interfere with zooming or scrolling

      const deltaX = touchEndX.current - touchStartX.current;
      const deltaY = touchEndY.current - touchStartY.current;

      // Ensure it's a deliberate horizontal swipe (more than 50px distance, mostly X-axis)
      if (Math.abs(deltaX) > 50 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5) {
          if (deltaX > 0) {
              // Swiped Right -> Go backward (or forward in RTL)
              if (settings.readingMode === 'rtl') nextPage(); else prevPage();
          } else {
              // Swiped Left -> Go forward (or backward in RTL)
              if (settings.readingMode === 'rtl') prevPage(); else nextPage();
          }
      }
  };

  const handleLeftClick = (e: React.MouseEvent) => { e.stopPropagation(); if (settings.readingMode === 'rtl') nextPage(); else prevPage(); };
  const handleRightClick = (e: React.MouseEvent) => { e.stopPropagation(); if (settings.readingMode === 'rtl') prevPage(); else nextPage(); };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isJumping) return;
      if (e.key === 'ArrowRight') { if (settings.readingMode === 'rtl') prevPage(); else nextPage(); }
      if (e.key === 'ArrowLeft') { if (settings.readingMode === 'rtl') nextPage(); else prevPage(); }
      if (e.key === 'Escape') { if (isFullscreen) document.exitFullscreen(); else router.back(); }
      if (e.key === '=' || e.key === '+') setZoomLevel(z => Math.min(z + 10, 300));
      if (e.key === '-') setZoomLevel(z => Math.max(z - 10, 50));
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nextPage, prevPage, router, settings.readingMode, isFullscreen, isJumping]);

  const handleMouseDown = (e: React.MouseEvent) => {
      if (zoomLevel === 100) return;
      setIsDragging(true);
      setDragDistance(0);
      if (scrollRef.current) {
          setDragStart({ x: e.pageX, y: e.pageY, scrollLeft: scrollRef.current.scrollLeft, scrollTop: scrollRef.current.scrollTop });
      }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
      if (!isDragging || !scrollRef.current) return;
      e.preventDefault(); 
      const dx = e.pageX - dragStart.x;
      const dy = e.pageY - dragStart.y;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) setDragDistance(10);
      scrollRef.current.scrollLeft = dragStart.scrollLeft - dx;
      scrollRef.current.scrollTop = dragStart.scrollTop - dy;
  };

  const handleMouseUp = () => setIsDragging(false);

  const handleClickCanvas = (e: React.MouseEvent) => {
      if (zoomLevel !== 100 && dragDistance > 5) return;
      setShowUI(!showUI);
  };

  if (error) return <div className="p-10 text-center text-red-500 font-bold">Error: {error}</div>;
  if (loading) return <div className="flex h-screen w-screen items-center justify-center bg-black"><Loader2 className="w-10 h-10 animate-spin text-white" /></div>;

  const uiVisible = showUI || hoverTop || hoverBottom || settingsOpen;
  const hideCursor = isIdle && !uiVisible;
  const currentBg = settings.backgroundColor === 'white' ? 'bg-[#f0f0f0]' : settings.backgroundColor === 'grey' ? 'bg-[#1e1e1e]' : 'bg-black';

  const isZoomed = zoomLevel !== 100;
  const isDouble = settings.pageLayout === 'double' || (settings.pageLayout === 'double-no-cover' && currentIndex !== 0);
  
  let imgClass = `shadow-2xl ${settings.animateTransitions === 'true' ? 'transition-all duration-300' : ''}`;
  
  if (!isZoomed) {
      if (settings.scaleType === 'screen') imgClass += ' w-full h-full object-contain';
      if (settings.scaleType === 'fit-height') imgClass += isDouble ? ' h-full max-w-[50%] object-contain' : ' h-full max-w-full object-contain';
      if (settings.scaleType === 'fit-width') imgClass += ' w-full h-auto object-contain';
      if (settings.scaleType === 'fit-width-shrink') imgClass += ' max-w-full h-auto object-contain';
      if (settings.scaleType === 'original') imgClass += ' w-auto h-auto max-w-none max-h-none';
  }

  // Combine scaling style with CSS Image Filters for Brightness/Contrast
  const imgStyle: React.CSSProperties = isZoomed ? {
      height: (settings.scaleType === 'fit-height' || settings.scaleType === 'screen' || settings.scaleType === 'original') ? `${zoomLevel}vh` : 'auto',
      width: (settings.scaleType === 'fit-width' || settings.scaleType === 'fit-width-shrink') ? (isDouble ? `${zoomLevel / 2}vw` : `${zoomLevel}vw`) : 'auto',
  } : {};

  if (settings.brightness !== 100 || settings.contrast !== 100) {
      imgStyle.filter = `brightness(${settings.brightness}%) contrast(${settings.contrast}%)`;
  }

  const gapClass = settings.spreadGap === 'small' ? 'gap-2' : settings.spreadGap === 'large' ? 'gap-8' : 'gap-0';

  return (
    <div className={`relative h-screen w-screen ${currentBg} overflow-hidden flex flex-col items-center justify-center select-none ${hideCursor ? 'cursor-none' : ''}`}>
      
      {/* TRIGGER ZONES */}
      <div className="absolute top-0 left-0 w-full h-20 z-40" onMouseEnter={() => setHoverTop(true)} onMouseLeave={() => setHoverTop(false)} />
      <div className="absolute bottom-0 left-0 w-full h-24 z-40" onMouseEnter={() => setHoverBottom(true)} onMouseLeave={() => setHoverBottom(false)} />

      {/* TOP BAR */}
      <div 
        className={`absolute top-0 left-0 w-full p-4 flex justify-between items-center bg-gradient-to-b from-black/90 to-transparent transition-all duration-300 z-50 ${uiVisible ? 'translate-y-0 opacity-100' : '-translate-y-full opacity-0'}`}
        onMouseEnter={() => setHoverTop(true)} 
        onMouseLeave={() => setHoverTop(false)}
      >
        <div className="flex items-center gap-2">
            <Button variant="ghost" className="text-white hover:bg-white/20 font-bold" onClick={() => router.back()}>
                <X className="w-5 h-5 md:mr-2" /> <span className="hidden md:inline">Close</span>
            </Button>
            
            {/* Zoom Controls (Hidden on narrow mobile screens) */}
            {settings.readingMode !== 'webtoon' && (
                <div className="hidden md:flex items-center bg-white/10 rounded-md border border-white/20 p-0.5 ml-4">
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-white hover:bg-white/20" onClick={() => setZoomLevel(z => Math.max(z - 10, 50))}><ZoomOut className="w-4 h-4" /></Button>
                    <span className="text-white text-xs font-mono w-12 text-center">{zoomLevel}%</span>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-white hover:bg-white/20" onClick={() => setZoomLevel(100)}><Search className="w-3.5 h-3.5" /></Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-white hover:bg-white/20" onClick={() => setZoomLevel(z => Math.min(z + 10, 300))}><ZoomIn className="w-4 h-4" /></Button>
                </div>
            )}
        </div>
        
        <div className="flex flex-col items-center text-white text-center max-w-[50%] absolute left-1/2 -translate-x-1/2">
          <span className="font-bold text-sm md:text-base truncate w-full tracking-tight">{seriesName}</span>
          <span className="opacity-70 text-xs truncate w-full">{issueName}</span>
        </div>
        
        <div className="flex gap-1 md:gap-2">
            <Button variant="ghost" size="icon" className={`text-white hover:bg-white/20 ${isMarkedRead ? 'text-green-500' : ''}`} onClick={toggleReadStatus} title="Mark as Read">
                <CheckCircle2 className="w-5 h-5" />
            </Button>
            <Button variant="ghost" size="icon" className="text-white hover:bg-white/20 hidden sm:flex" onClick={toggleFullscreen} title="Toggle Fullscreen">
                {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
            </Button>
            <Button variant="ghost" size="icon" className="text-white hover:bg-white/20" onClick={() => setSettingsOpen(true)} title="Reader Settings">
                <SettingsIcon className="w-5 h-5" />
            </Button>
        </div>
      </div>

      {/* CANVAS */}
      {settings.readingMode === 'webtoon' ? (
          <div className={`w-full h-full overflow-y-auto flex flex-col items-center z-10 ${hideCursor ? 'cursor-none' : ''}`} onClick={() => setShowUI(!showUI)}>
              {pages.map(p => (
                  <img 
                      key={p} 
                      src={`/api/reader/image?path=${encodeURIComponent(filePath!)}&page=${encodeURIComponent(p)}`} 
                      style={settings.brightness !== 100 || settings.contrast !== 100 ? { filter: `brightness(${settings.brightness}%) contrast(${settings.contrast}%)` } : undefined}
                      className="w-full max-w-4xl h-auto block m-0 p-0" 
                      loading="lazy" 
                      alt="Page" 
                  />
              ))}
          </div>
      ) : (
          <div 
              ref={scrollRef}
              className={`w-full h-full relative z-10 flex ${isZoomed ? 'overflow-auto cursor-grab active:cursor-grabbing items-start justify-start' : 'overflow-hidden items-center justify-center'}`}
              onMouseDown={isZoomed ? handleMouseDown : undefined}
              onMouseMove={isZoomed ? handleMouseMove : undefined}
              onMouseUp={isZoomed ? handleMouseUp : undefined}
              onMouseLeave={isZoomed ? handleMouseUp : undefined}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
          >
              <div 
                  className={`flex ${settings.readingMode === 'rtl' ? 'flex-row-reverse' : 'flex-row'} ${gapClass} ${isZoomed ? 'm-auto w-max h-max p-8 min-w-full min-h-full items-center justify-center' : 'w-full h-full items-center justify-center'}`}
                  onClick={handleClickCanvas}
              >
                  {/* Current Page */}
                  <img key={`p1-${currentIndex}`} src={`/api/reader/image?path=${encodeURIComponent(filePath!)}&page=${encodeURIComponent(pages[currentIndex])}`} style={imgStyle} className={imgClass} alt="Page" draggable={false} />
                  
                  {/* Optional Second Page */}
                  {isDouble && currentIndex + 1 < pages.length && (
                      <img key={`p2-${currentIndex+1}`} src={`/api/reader/image?path=${encodeURIComponent(filePath!)}&page=${encodeURIComponent(pages[currentIndex + 1])}`} style={imgStyle} className={imgClass} alt="Page 2" draggable={false} />
                  )}
              </div>
              
              {/* HOVER CLICK ZONES (Disabled when zooming to not interfere with panning) */}
              {!isZoomed && (
                  <>
                      <div className={`absolute inset-y-0 left-0 w-[25%] z-20 ${hideCursor ? 'cursor-none' : 'cursor-pointer'}`} onClick={handleLeftClick} title={settings.readingMode === 'rtl' ? "Next" : "Previous"} />
                      <div className={`absolute inset-y-0 right-0 w-[25%] z-20 ${hideCursor ? 'cursor-none' : 'cursor-pointer'}`} onClick={handleRightClick} title={settings.readingMode === 'rtl' ? "Previous" : "Next"} />
                  </>
              )}
          </div>
      )}

      {/* TRANSIENT PAGE INDICATOR */}
      {!uiVisible && settings.readingMode !== 'webtoon' && (
          <div className={`absolute bottom-6 right-6 z-40 bg-black/80 backdrop-blur-md text-white px-3 py-1.5 rounded-full text-xs font-bold tracking-widest uppercase transition-opacity duration-300 pointer-events-none ${showPageToast ? 'opacity-100' : 'opacity-0'}`}>
              Page {currentIndex + 1} / {pages.length}
          </div>
      )}

      {/* BOTTOM BAR / SCRUBBER */}
      {settings.readingMode !== 'webtoon' && (
          <div 
            className={`absolute bottom-0 left-0 w-full p-4 flex flex-col bg-gradient-to-t from-black/90 to-transparent transition-all z-50 ${uiVisible ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0'}`}
            onMouseEnter={() => setHoverBottom(true)} 
            onMouseLeave={() => setHoverBottom(false)}
          >
            <div className="flex justify-between items-center gap-2 md:gap-4 max-w-5xl mx-auto w-full pb-2 md:pb-0">
                <Button variant="ghost" size="icon" className="text-white hover:bg-white/20 shrink-0 hidden sm:flex" onClick={() => setCurrentIndex(0)} disabled={currentIndex === 0}><SkipBack className="w-5 h-5" /></Button>
                
                <Button variant="ghost" size="icon" className="text-white hover:bg-white/20 shrink-0" onClick={prevPage} disabled={currentIndex === 0}>
                    {settings.readingMode === 'rtl' ? <ChevronRight className="w-8 h-8" /> : <ChevronLeft className="w-8 h-8" />}
                </Button>
                
                <div className="flex flex-col flex-1 items-center gap-2 mx-2">
                    {/* Interactive Page Jumper (Enlarged for Mobile) */}
                    {isJumping ? (
                        <form onSubmit={handlePageJump} className="flex items-center gap-2 bg-black/50 p-1.5 rounded-md">
                            <Input 
                                autoFocus
                                type="number" 
                                min="1" max={pages.length} 
                                value={jumpInput} 
                                onChange={(e) => setJumpInput(e.target.value)}
                                className="h-8 w-16 text-center text-sm bg-white text-black font-bold" 
                            />
                            <span className="text-white text-[10px] sm:text-xs font-bold opacity-80 uppercase">of {pages.length}</span>
                            <Button type="submit" size="sm" className="h-8 px-3 bg-primary hover:bg-primary/90 text-primary-foreground font-bold">Go</Button>
                            <Button type="button" size="sm" variant="ghost" className="h-8 w-8 p-0 text-white" onClick={() => setIsJumping(false)}><X className="w-4 h-4"/></Button>
                        </form>
                    ) : (
                        <span 
                            className="text-white text-[11px] sm:text-xs font-bold opacity-80 uppercase tracking-widest cursor-pointer hover:text-primary hover:bg-white/10 px-3 py-1 rounded transition-colors"
                            onClick={() => { setIsJumping(true); setJumpInput((currentIndex + 1).toString()); }}
                            title="Click to jump to page"
                        >
                            Page {currentIndex + 1} <span className="text-white/50">of</span> {pages.length}
                        </span>
                    )}

                    {/* Progress Slider (Thicker for thumb grabbing) */}
                    <input 
                        type="range" 
                        min={0} 
                        max={pages.length - 1} 
                        value={currentIndex} 
                        onChange={(e) => setCurrentIndex(parseInt(e.target.value))} 
                        className="w-full h-2 md:h-1.5 bg-slate-700/50 rounded-lg appearance-none cursor-pointer accent-white hover:accent-primary transition-colors"
                        style={{ direction: settings.readingMode === 'rtl' ? 'rtl' : 'ltr' }}
                    />
                </div>

                {currentIndex >= pages.length - 1 && nextIssue ? (
                    <Button variant="default" className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold shadow-lg shrink-0 gap-2 text-xs sm:text-sm border-0" onClick={nextPage}>Next Issue <BookOpen className="w-4 h-4 hidden sm:block" /></Button>
                ) : (
                    <>
                        <Button variant="ghost" size="icon" className="text-white hover:bg-white/20 shrink-0" onClick={nextPage} disabled={currentIndex >= pages.length - 1}>
                             {settings.readingMode === 'rtl' ? <ChevronLeft className="w-8 h-8" /> : <ChevronRight className="w-8 h-8" />}
                        </Button>
                        <Button variant="ghost" size="icon" className="text-white hover:bg-white/20 shrink-0 hidden sm:flex" onClick={() => setCurrentIndex(pages.length - 1)} disabled={currentIndex >= pages.length - 1}><SkipForward className="w-5 h-5" /></Button>
                    </>
                )}
            </div>
          </div>
      )}

      {/* SETTINGS MODAL */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent className="sm:max-w-[425px] w-[95%] bg-background border-border rounded-xl">
              <DialogHeader><DialogTitle className="text-xl font-black tracking-tight text-foreground">Reader Settings</DialogTitle></DialogHeader>
              
              <div className="grid gap-6 py-4 max-h-[70vh] overflow-y-auto pr-2">
                  <div className="flex items-center justify-between bg-muted/50 p-3 rounded-lg border border-border">
                      <Label className="font-bold cursor-pointer text-sm" htmlFor="mark-read">Mark Issue as Completed</Label>
                      <Switch id="mark-read" checked={isMarkedRead} onCheckedChange={toggleReadStatus} />
                  </div>
                  
                  <div className="space-y-4">
                      <div className="grid grid-cols-[30px_1fr] items-center gap-3">
                          <LayoutTemplate className="w-5 h-5 text-muted-foreground justify-self-center" />
                          <div className="grid gap-1.5">
                              <Label className="text-[10px] sm:text-xs uppercase tracking-wider text-muted-foreground font-bold">Reading Mode & Layout</Label>
                              <div className="grid grid-cols-2 gap-2">
                                  <Select value={settings.readingMode} onValueChange={(v) => setSettings(s => ({...s, readingMode: v}))}>
                                      <SelectTrigger className="h-10 text-xs sm:text-sm border-border bg-background"><SelectValue /></SelectTrigger>
                                      <SelectContent className="bg-popover border-border">
                                          <SelectItem value="ltr" className="focus:bg-primary/10 focus:text-primary">Left to Right</SelectItem>
                                          <SelectItem value="rtl" className="focus:bg-primary/10 focus:text-primary">Right to Left</SelectItem>
                                          <SelectItem value="webtoon" className="focus:bg-primary/10 focus:text-primary">Webtoon</SelectItem>
                                      </SelectContent>
                                  </Select>
                                  <Select value={settings.pageLayout} onValueChange={(v) => setSettings(s => ({...s, pageLayout: v}))} disabled={settings.readingMode === 'webtoon'}>
                                      <SelectTrigger className="h-10 text-xs sm:text-sm border-border bg-background"><SelectValue /></SelectTrigger>
                                      <SelectContent className="bg-popover border-border">
                                          <SelectItem value="single" className="focus:bg-primary/10 focus:text-primary">Single Page</SelectItem>
                                          <SelectItem value="double" className="focus:bg-primary/10 focus:text-primary">Double Page</SelectItem>
                                          <SelectItem value="double-no-cover" className="focus:bg-primary/10 focus:text-primary">Double (No Cover)</SelectItem>
                                      </SelectContent>
                                  </Select>
                              </div>
                          </div>
                      </div>

                      {/* Manga Spread Gutter Setup */}
                      <div className="grid grid-cols-[30px_1fr] items-center gap-3">
                          <AlignHorizontalSpaceAround className="w-5 h-5 text-muted-foreground justify-self-center" />
                          <div className="grid gap-1.5">
                              <Label className="text-[10px] sm:text-xs uppercase tracking-wider text-muted-foreground font-bold">2-Page Spread Gutter</Label>
                              <Select value={settings.spreadGap} onValueChange={(v) => setSettings(s => ({...s, spreadGap: v}))} disabled={settings.pageLayout === 'single' || settings.readingMode === 'webtoon'}>
                                  <SelectTrigger className="h-10 text-xs sm:text-sm border-border bg-background"><SelectValue /></SelectTrigger>
                                  <SelectContent className="bg-popover border-border">
                                      <SelectItem value="none" className="focus:bg-primary/10 focus:text-primary">Seamless (No Gap)</SelectItem>
                                      <SelectItem value="small" className="focus:bg-primary/10 focus:text-primary">Book Binding (Small)</SelectItem>
                                      <SelectItem value="large" className="focus:bg-primary/10 focus:text-primary">Book Binding (Large)</SelectItem>
                                  </SelectContent>
                              </Select>
                          </div>
                      </div>

                      <div className="grid grid-cols-[30px_1fr] items-center gap-3">
                          <MonitorPlay className="w-5 h-5 text-muted-foreground justify-self-center" />
                          <div className="grid gap-1.5">
                              <Label className="text-[10px] sm:text-xs uppercase tracking-wider text-muted-foreground font-bold">Scale Type</Label>
                              <Select value={settings.scaleType} onValueChange={(v) => setSettings(s => ({...s, scaleType: v}))} disabled={settings.readingMode === 'webtoon'}>
                                  <SelectTrigger className="h-10 text-xs sm:text-sm border-border bg-background"><SelectValue /></SelectTrigger>
                                  <SelectContent className="bg-popover border-border">
                                      <SelectItem value="screen" className="focus:bg-primary/10 focus:text-primary">Screen (Fit Best)</SelectItem>
                                      <SelectItem value="fit-height" className="focus:bg-primary/10 focus:text-primary">Fit Height</SelectItem>
                                      <SelectItem value="fit-width" className="focus:bg-primary/10 focus:text-primary">Fit Width</SelectItem>
                                      <SelectItem value="fit-width-shrink" className="focus:bg-primary/10 focus:text-primary">Fit Width (Shrink Only)</SelectItem>
                                      <SelectItem value="original" className="focus:bg-primary/10 focus:text-primary">Original Size</SelectItem>
                                  </SelectContent>
                              </Select>
                          </div>
                      </div>

                      <div className="grid grid-cols-[30px_1fr] items-center gap-3">
                          <Paintbrush className="w-5 h-5 text-muted-foreground justify-self-center" />
                          <div className="grid gap-1.5">
                              <Label className="text-[10px] sm:text-xs uppercase tracking-wider text-muted-foreground font-bold">Background Color</Label>
                              <Select value={settings.backgroundColor} onValueChange={(v) => setSettings(s => ({...s, backgroundColor: v}))}>
                                  <SelectTrigger className="h-10 text-xs sm:text-sm border-border bg-background"><SelectValue /></SelectTrigger>
                                  <SelectContent className="bg-popover border-border">
                                      <SelectItem value="black" className="focus:bg-primary/10 focus:text-primary">Pitch Black</SelectItem>
                                      <SelectItem value="grey" className="focus:bg-primary/10 focus:text-primary">Dark Gray</SelectItem>
                                      <SelectItem value="white" className="focus:bg-primary/10 focus:text-primary">Bright White</SelectItem>
                                  </SelectContent>
                              </Select>
                          </div>
                      </div>

                      <div className="grid grid-cols-[30px_1fr] items-center gap-3">
                          <Zap className="w-5 h-5 text-muted-foreground justify-self-center" />
                          <div className="grid gap-1.5">
                              <Label className="text-[10px] sm:text-xs uppercase tracking-wider text-muted-foreground font-bold">Page Transitions</Label>
                              <Select value={settings.animateTransitions} onValueChange={(v) => setSettings(s => ({...s, animateTransitions: v}))}>
                                  <SelectTrigger className="h-10 text-xs sm:text-sm border-border bg-background"><SelectValue /></SelectTrigger>
                                  <SelectContent className="bg-popover border-border">
                                      <SelectItem value="true" className="focus:bg-primary/10 focus:text-primary">Smooth Fade</SelectItem>
                                      <SelectItem value="false" className="focus:bg-primary/10 focus:text-primary">Instant</SelectItem>
                                  </SelectContent>
                              </Select>
                          </div>
                      </div>

                      {/* --- NEW: Image Adjustments (Brightness/Contrast) --- */}
                      <div className="grid grid-cols-[30px_1fr] items-start gap-3 pt-2 border-t border-border">
                          <Sun className="w-5 h-5 text-muted-foreground justify-self-center mt-1" />
                          <div className="grid gap-4">
                              <div className="space-y-3">
                                  <div className="flex flex-col gap-1.5">
                                      <div className="flex items-center justify-between">
                                          <Label className="text-[10px] sm:text-xs uppercase tracking-wider text-muted-foreground font-bold">Brightness</Label>
                                          <span className="text-[10px] font-mono text-muted-foreground">{settings.brightness}%</span>
                                      </div>
                                      <input 
                                          type="range" min="50" max="150" step="5" 
                                          value={settings.brightness} 
                                          onChange={(e) => setSettings(s => ({...s, brightness: parseInt(e.target.value)}))} 
                                          className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                                      />
                                  </div>
                                  <div className="flex flex-col gap-1.5">
                                      <div className="flex items-center justify-between">
                                          <Label className="text-[10px] sm:text-xs uppercase tracking-wider text-muted-foreground font-bold">Contrast</Label>
                                          <span className="text-[10px] font-mono text-muted-foreground">{settings.contrast}%</span>
                                      </div>
                                      <input 
                                          type="range" min="50" max="150" step="5" 
                                          value={settings.contrast} 
                                          onChange={(e) => setSettings(s => ({...s, contrast: parseInt(e.target.value)}))} 
                                          className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                                      />
                                  </div>
                                  
                                  {(settings.brightness !== 100 || settings.contrast !== 100) && (
                                      <div className="flex justify-end pt-1">
                                          <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px] uppercase tracking-widest text-muted-foreground hover:bg-muted" onClick={() => setSettings(s => ({...s, brightness: 100, contrast: 100}))}>
                                              Reset Adjustments
                                          </Button>
                                      </div>
                                  )}
                              </div>
                          </div>
                      </div>

                  </div>
              </div>
          </DialogContent>
      </Dialog>
    </div>
  )
}

// Add this at the absolute bottom of app/reader/page.tsx
export default function ReaderPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black flex items-center justify-center text-white">Loading Reader...</div>}>
      <ReaderContent />
    </Suspense>
  )
}