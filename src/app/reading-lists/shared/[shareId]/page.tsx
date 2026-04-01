import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { BookOpen, ListOrdered } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

// This is a Server Component, meaning it loads instantly and has great SEO/sharing previews
export default async function SharedReadingListPage({ params }: { params: { shareId: string } }) {
    // 1. Await params in Next.js 15+
    const resolvedParams = await params;
    
    // 2. Fetch the list using the unique share ID
    const list = await prisma.readingList.findFirst({
        where: { shareId: resolvedParams.shareId },
        include: {
            user: { select: { username: true } },
            items: {
                orderBy: { order: 'asc' },
                include: { issue: { include: { series: true } } }
            }
        }
    });

    // 3. If the ID is invalid, throw a 404 page
    if (!list) return notFound();

    return (
        <div className="container mx-auto py-10 px-6 max-w-4xl space-y-8">
            <title>{`Omnibus - ${list.name}`}</title>
            
            {/* Header Banner */}
            <Card className="shadow-sm border-primary/20 bg-primary/5">
                <CardHeader>
                    <CardTitle className="text-3xl font-black text-primary flex items-center gap-3">
                        <ListOrdered className="w-8 h-8" /> {list.name}
                    </CardTitle>
                    {list.description && (
                        <CardDescription className="text-lg mt-2 text-foreground/80">
                            {list.description}
                        </CardDescription>
                    )}
                    <p className="text-sm text-muted-foreground mt-4">
                        Curated by <span className="font-bold">{list.user?.username || "System Admin"}</span>
                    </p>
                </CardHeader>
            </Card>

            {/* Comic List */}
            <div className="space-y-4">
                {list.items.map((item, index) => {
                    const issue = item.issue;
                    const series = issue?.series;
                    
                    // Provide a visual fallback if the issue is currently missing from the server
                    if (!issue) return (
                        <div key={item.id} className="flex items-center gap-4 p-4 bg-muted/50 border border-dashed border-border rounded-xl opacity-70">
                            <span className="font-mono text-sm text-muted-foreground w-6">{index + 1}.</span>
                            <div className="flex-1 font-bold">{item.title}</div>
                            <span className="text-xs uppercase text-orange-500 font-bold tracking-wider">Unavailable</span>
                        </div>
                    );

                    return (
                        <div key={item.id} className="flex items-center gap-4 p-4 bg-background border border-border rounded-xl shadow-sm hover:border-primary/50 transition-colors">
                            <span className="font-mono text-sm text-muted-foreground w-6 font-bold">{index + 1}.</span>
                            <div className="flex-1 min-w-0">
                                <h4 className="font-bold text-foreground truncate">{series?.name}</h4>
                                <p className="text-sm text-muted-foreground truncate">Issue #{issue.number} • {issue.name || "Untitled"}</p>
                            </div>
                            
                            {/* Send them directly into the reader */}
                            <Button size="sm" asChild className="shrink-0 bg-primary hover:bg-primary/90 text-primary-foreground font-bold">
                                <Link href={`/reader?path=${encodeURIComponent(issue.filePath || '')}&series=${encodeURIComponent(series?.folderPath || '')}`}>
                                    <BookOpen className="w-4 h-4 mr-2" /> Read
                                </Link>
                            </Button>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}