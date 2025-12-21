import { WritableStream, ReadableStream } from 'node:stream/web';
import { createLogger } from './logger.js';

const logStreams = createLogger('acp:streams');

export function nodeToWebWritable(nodeStream) {
  return new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        const canContinue = nodeStream.write(Buffer.from(chunk), (err) => {
          if (err) {
            logStreams.error('Writable stream error', { error: err.message, chunkSize: chunk.length });
            reject(err);
          }
        });
        if (canContinue) {
          resolve();
        } else {
          // Backpressure: wait for drain before resolving
          nodeStream.once('drain', resolve);
        }
      });
    },
  });
}

export function nodeToWebReadable(nodeStream) {
  return new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
      nodeStream.on('end', () => controller.close());
      nodeStream.on('error', (err) => {
        logStreams.error('Readable stream error', { error: err.message });
        controller.error(err);
      });
    },
    cancel(reason) {
      nodeStream.destroy(reason instanceof Error ? reason : undefined);
    },
  });
}
