// src/lib/logger.ts
type LogEntry = { timestamp: string; message: string; type: 'info' | 'error' | 'success' | 'warn' | 'debug' };

// Prevent logs from being cleared during Next.js Hot Reloads, and persist the log level
const globalForLogger = global as unknown as { logBuffer: LogEntry[], currentLogLevel: string };
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
    
    // Assign colors for the console (Debug gets a muted cyan/gray)
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
            const logDir = process.env.OMNIBUS_LOGS_DIR || path.join(process.cwd(), 'config', 'logs');
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
            const logFile = path.join(logDir, 'omnibus.log');
            const logLine = `[${timestamp}] [${type.toUpperCase()}] ${msgStr}\n`;
            fs.appendFileSync(logFile, logLine);
        } catch (err) {
            console.error("Failed to write to log file", err);
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
                const logDir = process.env.OMNIBUS_LOGS_DIR || path.join(process.cwd(), 'config', 'logs');
                const logFile = path.join(logDir, 'omnibus.log');
                fs.writeFileSync(logFile, "");
            } catch(e) {}
        }).catch(() => {});
    }
  }
};