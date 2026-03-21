type LogEntry = { timestamp: string; message: string; type: 'info' | 'error' | 'success' | 'warn' };

// Prevent logs from being cleared during Next.js Hot Reloads
const globalForLogger = global as unknown as { logBuffer: LogEntry[] };
if (!globalForLogger.logBuffer) globalForLogger.logBuffer = [];

export const Logger = {
  log(message: string, type: LogEntry['type'] = 'info') {
    // --- FIX 6a: Standardize on ISO 8601 timestamps ---
    const timestamp = new Date().toISOString(); 
    const msgStr = typeof message === 'string' ? message : JSON.stringify(message);
    
    const entry: LogEntry = { timestamp, message: msgStr, type };
    
    // BROWSER SAFEGUARD
    if (typeof window !== 'undefined') {
        if (type === 'error') console.error(`[Omnibus] ${msgStr}`);
        else if (type === 'warn') console.warn(`[Omnibus] ${msgStr}`);
        else console.log(`[Omnibus] ${msgStr}`);
        return; 
    }

    // SERVER-SIDE ONLY
    globalForLogger.logBuffer.unshift(entry);
    
    if (globalForLogger.logBuffer.length > 1000) {
      globalForLogger.logBuffer.pop();
    }
    
    const color = type === 'error' ? '\x1b[31m' : type === 'success' ? '\x1b[32m' : type === 'warn' ? '\x1b[33m' : '\x1b[34m';
    console.log(`${color}[Omnibus] ${msgStr}\x1b[0m`);

    try {
        const fs = eval('require')('fs');
        const path = eval('require')('path');
        
        const logDir = process.env.LOG_PATH || path.join(process.cwd(), 'config', 'logs');
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        const logFile = path.join(logDir, 'omnibus.log');
        const logLine = `[${timestamp}] [${type.toUpperCase()}] ${msgStr}\n`;
        fs.appendFileSync(logFile, logLine);
    } catch (err) {
        console.error("Failed to write to log file", err);
    }
  },
  
  getLogs() {
    return globalForLogger.logBuffer;
  },
  
  clear() {
    globalForLogger.logBuffer = [];
    try {
        if (typeof window === 'undefined') {
            const fs = eval('require')('fs');
            const path = eval('require')('path');
            const logDir = process.env.LOG_PATH || path.join(process.cwd(), 'config', 'logs');
            const logFile = path.join(logDir, 'omnibus.log');
            fs.writeFileSync(logFile, "");
        }
    } catch(e) {}
  }
};