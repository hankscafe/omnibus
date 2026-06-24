// src/lib/logger.ts
import { LOGS_DIR } from './utils/paths';

type LogEntry = { timestamp: string; message: string; type: 'info' | 'error' | 'success' | 'warn' | 'debug' };

// --- Physical log-file rotation config (env-overridable; NO DB dependency so the Logger stays
// self-contained and safe to call before the DB is ready). Each file is capped at OMNIBUS_LOG_MAX_MB
// and we keep OMNIBUS_LOG_KEEP_FILES numbered archives (omnibus.log.1 … .N), so total disk is bounded
// to ~MAX_MB * (KEEP + 1). Defaults: 50 MB * 10 ≈ 550 MB ceiling. ---
const LOG_MAX_BYTES = Math.max(1, parseInt(process.env.OMNIBUS_LOG_MAX_MB || '50', 10) || 50) * 1024 * 1024;
const LOG_KEEP_FILES = Math.max(1, parseInt(process.env.OMNIBUS_LOG_KEEP_FILES || '10', 10) || 10);

// ISO-8601 week key (e.g. "2026-W26"). A change in this value forces a rotation, so logs roll at week
// boundaries even when volume is low. Exported for unit testing the (fiddly) week-number math.
export function isoWeekKey(d: Date): string {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
    date.setUTCDate(date.getUTCDate() - dayNum + 3); // Thursday decides the ISO week-year
    const thursday = date.getTime();
    date.setUTCMonth(0, 1);
    if (date.getUTCDay() !== 4) {
        date.setUTCMonth(0, 1 + ((4 - date.getUTCDay()) + 7) % 7);
    }
    const week = 1 + Math.ceil((thursday - date.getTime()) / 604800000);
    return `${new Date(thursday).getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Shift omnibus.log -> .1 -> .2 … dropping anything past LOG_KEEP_FILES. Fully synchronous so it runs
// atomically inside a single log write (Node is single-threaded; no await here = no interleaving race).
function rotateLogFiles(fs: any, basePath: string) {
    try { fs.rmSync(`${basePath}.${LOG_KEEP_FILES}`, { force: true }); } catch {}
    for (let i = LOG_KEEP_FILES - 1; i >= 1; i--) {
        try { if (fs.existsSync(`${basePath}.${i}`)) fs.renameSync(`${basePath}.${i}`, `${basePath}.${i + 1}`); } catch {}
    }
    try { if (fs.existsSync(basePath)) fs.renameSync(basePath, `${basePath}.1`); } catch {}
}

// Prevent logs from being cleared during Next.js Hot Reloads, and persist the log level + rotation state
const globalForLogger = global as unknown as { logBuffer: LogEntry[], currentLogLevel: string, logBytes?: number, logWeek?: string };

if (!globalForLogger.logBuffer) globalForLogger.logBuffer = [];
if (!globalForLogger.currentLogLevel) globalForLogger.currentLogLevel = 'info'; // Default to info

export const Logger = {
  // Method to dynamically change the level without restarting the server
  setLevel(level: 'info' | 'debug') {
    globalForLogger.currentLogLevel = level;
    this.log(`System log level changed to: ${level.toUpperCase()}`, 'info');
  },
  getLevel() {
    return globalForLogger.currentLogLevel;
  },
  log(message: string, type: LogEntry['type'] = 'info') {
    // Drop debug logs if the system is currently in info mode
    if (type === 'debug' && globalForLogger.currentLogLevel !== 'debug') {
      return; 
    }
    const timestamp = new Date().toISOString(); 
    const msgStr = typeof message === 'string' ? message : JSON.stringify(message);
    const entry: LogEntry = { timestamp, message: msgStr, type };
    
    // BROWSER SAFEGUARD
    if (typeof window !== 'undefined') {
        if (type === 'error') console.error(`[Omnibus] ${msgStr}`);
        else if (type === 'warn') console.warn(`[Omnibus] ${msgStr}`);
        else if (type === 'debug') console.debug(`[Omnibus Debug] ${msgStr}`);
        else console.log(`[Omnibus] ${msgStr}`);
        return; 
    }

    // SERVER-SIDE ONLY
    globalForLogger.logBuffer.unshift(entry);
    if (globalForLogger.logBuffer.length > 1000) {
      globalForLogger.logBuffer.pop();
    }
    
    // Assign colors for the console
    let color = '\x1b[34m'; // default blue info
    if (type === 'error') color = '\x1b[31m';
    if (type === 'success') color = '\x1b[32m';
    if (type === 'warn') color = '\x1b[33m';
    if (type === 'debug') color = '\x1b[36m'; // Cyan for debug
    
    console.log(`${color}[Omnibus] ${type === 'debug' ? '[DEBUG] ' : ''}${msgStr}\x1b[0m`);

    // Write everything to the physical exportable log file
    Promise.all([
        import(/* webpackIgnore: true */ 'fs'), 
        import(/* webpackIgnore: true */ 'path')
    ]).then(([fsRaw, pathRaw]) => {
        const fs = fsRaw.default || fsRaw;
        const path = pathRaw.default || pathRaw;
        
        try {
            const logDir = LOGS_DIR;
            
            // --- THE FIX: Wrap mkdirSync inside a quiet error trap to safely handle existing shared Docker mounts ---
            if (!fs.existsSync(logDir)) {
                try {
                    fs.mkdirSync(logDir, { recursive: true });
                } catch (mkdirErr: any) {
                    if (mkdirErr.code !== 'EEXIST') throw mkdirErr;
                }
            }
            
            const logFile = path.join(logDir, 'omnibus.log');
            const logLine = `[${timestamp}] [${type.toUpperCase()}] ${msgStr}\n`;

            // --- ROTATION: roll the file when it crosses the size cap OR a new ISO week begins. ---
            // The size is tracked in memory (seeded once from disk) so the hot path never stats per write;
            // the existsSync/rename work only runs on the rare turn a rotation actually fires.
            if (globalForLogger.logBytes === undefined) {
                try { globalForLogger.logBytes = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0; }
                catch { globalForLogger.logBytes = 0; }
            }
            const week = isoWeekKey(new Date(timestamp));
            if (globalForLogger.logWeek === undefined) globalForLogger.logWeek = week;

            if ((globalForLogger.logBytes >= LOG_MAX_BYTES || week !== globalForLogger.logWeek) && globalForLogger.logBytes > 0) {
                rotateLogFiles(fs, logFile);
                globalForLogger.logBytes = 0;
                globalForLogger.logWeek = week;
            }

            fs.appendFileSync(logFile, logLine);
            globalForLogger.logBytes = (globalForLogger.logBytes || 0) + Buffer.byteLength(logLine);
        } catch (err) {
            // Suppress secondary streams write alerts to avoid filling Docker standard streams completely
        }
    }).catch(() => {});
  },
  getLogs() {
    return globalForLogger.logBuffer;
  },
  clear() {
    globalForLogger.logBuffer = [];
    if (typeof window === 'undefined') {
        Promise.all([
            import(/* webpackIgnore: true */ 'fs'), 
            import(/* webpackIgnore: true */ 'path')
        ]).then(([fsRaw, pathRaw]) => {
            const fs = fsRaw.default || fsRaw;
            const path = pathRaw.default || pathRaw;
            try {
                const logDir = LOGS_DIR;
                const logFile = path.join(logDir, 'omnibus.log');
                fs.writeFileSync(logFile, "");
                globalForLogger.logBytes = 0; // keep the tracked size in sync with the truncated file
            } catch(e) {}
        }).catch(() => {});
    }
  }
};