import { NextResponse } from 'next/server';
// Directly import the package.json to guarantee version reading inside Docker
import packageJson from '../../../../../package.json';

export async function GET() {
  try {
    // 1. Get current version securely (Safe for Docker)
    const currentVersion = packageJson.version || "1.0.0";
    
    // 2. Fetch the last 10 releases from your GitHub repo
    const res = await fetch('https://api.github.com/repos/hankscafe/omnibus/releases?per_page=10', {
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

    // 3. Compare latest release tag (removing 'v' prefix if it exists) to current version
    const latestVersion = releases[0].tag_name.replace(/^v/, '');
    const updateAvailable = latestVersion !== currentVersion;

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