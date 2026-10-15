/** Socket TLS para Node (servidor propio o desarrollo local). */
import { Duplex } from 'node:stream';
import { connect } from 'node:tls';
import type { OpenSocket } from '../modules/mail/smtpClient.js';

export const openNodeSocket: OpenSocket = (host, port) =>
  new Promise((resolve, reject) => {
    const socket = connect({ host, port, servername: host }, () => {
      const { readable, writable } = Duplex.toWeb(socket) as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
      resolve({ readable, writable, close: async () => void socket.end() });
    });
    socket.once('error', reject);
  });
