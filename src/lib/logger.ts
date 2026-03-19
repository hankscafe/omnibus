type LogEntry = { timestamp: string; message: string; type: 'info' | 'error' | 'success' | 'warn' };

// Prevent logs from being cleared during Next.js Hot Reloads
const globalForLogger = global as unknown as { logBuffer: LogEntry[] };
if (!globalForLogger.logBuffer) globalForLogger.logBuffer = [];

export const Logger = {
  log(message: string, type: LogEntry['type'] = 'info') {
    const entry = {
      timestamp: new Date().toLocaleTimeString(),
      message: typeof message === 'string' ? message : JSON.stringify(message),
      type
    };
    
    globalForLogger.logBuffer.unshift(entry);
    if (globalForLogger.logBuffer.length > 100) {
      globalForLogger.logBuffer.pop();
    }
    
    // Also print to actual terminal
    const color = type === 'error' ? '\x1b[31m' : type === 'success' ? '\x1b[32m' : type === 'warn' ? '\x1b[33m' : '\x1b[34m';
    
    // FIX: This must be console.log, NOT Logger.log!
    console.log(`${color}[Omnibus] ${message}\x1b[0m`);
  },
  getLogs() {
    return globalForLogger.logBuffer;
  },
  clear() {
    globalForLogger.logBuffer = [];
  }
};