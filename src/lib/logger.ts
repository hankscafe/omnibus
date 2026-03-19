// --- ADDED 'warn' TO THE TYPE UNION ---
type LogEntry = { timestamp: string; message: string; type: 'info' | 'error' | 'success' | 'warn' };

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
    
    // --- ADDED YELLOW TERMINAL COLOR FOR WARNINGS ---
    const color = type === 'error' ? '\x1b[31m' : type === 'success' ? '\x1b[32m' : type === 'warn' ? '\x1b[33m' : '\x1b[34m';
    Logger.log(`${color}[Omnibus] ${message}\x1b[0m`, 'info');
  },
  getLogs() {
    return globalForLogger.logBuffer;
  },
  clear() {
    globalForLogger.logBuffer = [];
  }
};