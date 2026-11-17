// WebSocket implementation for nostr-tools under Node (the app uses React Native's).
//
// - Node's built-in WebSocket recurses forever when nostr-tools closes it from an
//   error handler (refused connections), so use the `ws` package instead.
// - `ws` emits an 'error' event when nostr-tools abandons a connection that is still
//   opening (slow relay); with no listener that would crash the process. nostr-tools
//   already handles failures through `onerror`/`onclose`, so swallow the event here.
import WebSocket from 'ws';

export class NodeWebSocket extends WebSocket {
  constructor(...args) {
    super(...args);
    this.on('error', () => {});
  }
}
