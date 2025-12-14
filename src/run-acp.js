import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { nodeToWebReadable, nodeToWebWritable } from './utils.js';
import { AmpAcpAgent } from './server.js';
import { createLogger } from './logger.js';
import fs from 'node:fs';

const log = createLogger('acp:conn');
const protocolLog = createLogger('acp:wire');

// Debug: log all outgoing messages
const DEBUG_WIRE = process.env.AMP_ACP_DEBUG_WIRE === '1';

export function runAcp() {
  let wrappedStdout = process.stdout;
  
  if (DEBUG_WIRE) {
    // Create a passthrough that logs everything written
    const originalWrite = process.stdout.write.bind(process.stdout);
    wrappedStdout = {
      write: (chunk, encoding, callback) => {
        try {
          const str = typeof chunk === 'string' ? chunk : chunk.toString();
          const parsed = JSON.parse(str.trim());
          protocolLog.debug('OUT', { message: JSON.stringify(parsed, null, 2) });
        } catch {
          protocolLog.debug('OUT (raw)', { data: chunk.toString().substring(0, 500) });
        }
        return originalWrite(chunk, encoding, callback);
      },
      on: process.stdout.on.bind(process.stdout),
      once: process.stdout.once.bind(process.stdout),
      emit: process.stdout.emit.bind(process.stdout),
      end: process.stdout.end.bind(process.stdout),
    };
  }
  
  const input = nodeToWebWritable(wrappedStdout);
  const output = nodeToWebReadable(process.stdin);
  const stream = ndJsonStream(input, output);
  
  // Create deferred signal pattern to avoid race condition:
  // Agent is created synchronously in the callback, but connection.signal
  // isn't available until after AgentSideConnection constructor returns.
  // We capture a resolver and inject the signal immediately after.
  let resolveSignal;
  const signalPromise = new Promise((resolve) => { resolveSignal = resolve; });
  
  const connection = new AgentSideConnection((client) => {
    return new AmpAcpAgent(client, signalPromise);
  }, stream);

  // Resolve the signal promise now that connection is created
  resolveSignal(connection.signal);

  // Log and cleanup when connection closes
  connection.signal.addEventListener('abort', () => {
    log.info('Connection closed');
  });

  // Optional: await closed for graceful shutdown
  connection.closed.then(() => {
    log.info('Connection stream ended');
  }).catch((err) => {
    log.error('Connection error', { error: err.message });
  });
}
