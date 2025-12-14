#!/usr/bin/env node
import { rootLog } from './logger.js';

// Global error handlers to prevent silent crashes
process.on('unhandledRejection', (reason) => {
  rootLog.error('Unhandled rejection', { reason: String(reason) });
});

process.on('uncaughtException', (err) => {
  rootLog.error('Uncaught exception', { error: err.message, stack: err.stack });
});

import { runAcp } from './run-acp.js';

runAcp();

// Keep process alive
process.stdin.resume();
