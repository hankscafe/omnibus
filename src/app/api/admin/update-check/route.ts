import { NextResponse } from 'next/server';
// Directly import the package.json to guarantee version reading inside Docker
import packageJson from '../../../../../package.json';

// Helper function to properly compare SemVer strings (e.g., 1.0.0-beta.4 > 1.0.0-beta.3)
function isNewerVersion(latest: string, current: string): boolean {
    const cleanLatest = latest.replace(/^v/, '');
    const cleanCurrent = current.replace(/^v/, '');
    
    if (cleanLatest === cleanCurrent) return false;

    const parse = (v: string) => {
        const [main, pre] = v.split('-');
        return {
            nums: main.split('.').map(n => parseInt(n, 10) || 0),
            preParts: pre ? pre.split('.') : []
        };
    };

    const l = parse(cleanLatest);
    const c = parse(cleanCurrent);

    // 1. Compare Major.Minor.Patch
    for (let i = 0; i < 3; i++) {
        const lNum = l.nums[i] || 0;
        const cNum = c.nums[i] || 0;
        if (lNum > cNum) return true;
        if (lNum < cNum) return false;
    }

    // 2. Main versions are identical. Check pre-releases.
    if (l.preParts.length === 0 && c.preParts.length > 0) return true; // 1.0.0 > 1.0.0-beta
    if (l.preParts.length > 0 && c.preParts.length === 0) return false; // 1.0.0-beta < 1.0.0

    // 3. Both are pre-releases (e.g., beta.3 vs beta.4). Compare dot-separated parts.
    for (let i = 0; i < Math.max(l.preParts.length, c.preParts.length); i++) {
        const lPart = l.preParts[i];
        const cPart = c.preParts[i];

        if (lPart === undefined) return false; 
        if (cPart === undefined) return true;

        const lIsNum = !isNaN(Number(lPart));
        const cIsNum = !isNaN(Number(cPart));

        if (lIsNum && cIsNum) {
            if (Number(lPart) > Number(cPart)) return true;
            if (Number(lPart) < Number(cPart)) return false;
        } else if (!lIsNum && !cIsNum) {
            if (lPart > cPart) return true;
            if (lPart < cPart) return false;
        } else {
            return !lIsNum; 
        }
    }
    return false;
}

export async function GET() {
  try {
    // 1. Get current version securely (Safe for Docker)
    const currentVersion = packageJson.version || "1.0.0";
    
    // 2. Fetch the last 10 releases from your GitHub repo
    const res = await fetch('https://api.github.com/repos/hankscafe/omnibus/releases?per_page=100', {
        headers: { 
          'User-Agent': 'Omnibus-App',
          'Accept': 'application/vnd.github.v3+json'
        },
        next: { revalidate: 3600 } // Cache for 1 hour to respect GitHub API limits
    });
    
    if (!res.ok) throw new Error("Failed to fetch from GitHub");
    
    const releases = await res.json();
    if (!releases || releases.length === 0) {
        return NextResponse.json({ updateAvailable: false, currentVersion, latestVersion: currentVersion, releases: [] });
    }

    // 3. Compare latest release tag using our mathematical SemVer check
    const latestVersion = releases[0].tag_name.replace(/^v/, '');
    const updateAvailable = isNewerVersion(latestVersion, currentVersion);

    return NextResponse.json({
      updateAvailable,
      currentVersion,
      latestVersion,
      releases // Send the whole array to the frontend for the history page
    });

  } catch (error) {
    // Fail gracefully so the Admin Dashboard doesn't crash if GitHub is down
    return NextResponse.json(
      { 
        updateAvailable: false, 
        currentVersion: packageJson?.version || "1.0.0", 
        releases: [],
        error: "Could not check for updates" 
      }, 
      { status: 200 }
    );
  }
}