# recon-handshake

One-shot CDP recon to extract everything needed to open a Figma multiplayer WebSocket from Node, then never touch Chrome again. The bridge between [[capture]] (Chrome-attached) and [[standalone-client]] (fully standalone).

## What it produces

Writes `/tmp/figma_handshake.json` with the multiplayer URL pattern, the request/response handshake headers, and all `figma.com` cookies. The standalone client reads this file and never opens CDP itself.

### Output schema

The JSON contains every WebSocket observed during the recon window. Typically two: `livegraph` (text-based queries) and `multiplayer` (binary scenegraph). [[standalone-client#Standalone client#standalone-client.mjs#Connection sequence]] picks the multiplayer one by URL pattern match.

```json
{
  "capturedAt": "2026-04-06T...",
  "tab": { "title": "...", "url": "..." },
  "sockets": [
    {
      "requestId": "...",
      "url": "wss://www.figma.com/api/multiplayer/<file>?...",
      "requestHeaders": { "Origin": "...", "Cookie": "...", ... },
      "responseHeaders": { ... },
      "frameStats": { "sentBin": 0, "recvBin": 6, "sentText": 0, "recvText": 0 }
    },
    ...
  ],
  "cookies": [ { "name": "...", "value": "...", "domain": "..." }, ... ]
}
```

## How it works

A pure CDP listener: subscribes to `Network.webSocket*` events around a `Page.reload`, dumps the result, exits. No JS injection, no in-page hooks.

### Steps

Each step is direct CDP. The whole script is ~120 lines, no dependencies beyond Node built-ins.

1. Connect to Chrome via `CDP_WS_URL`, find a Figma tab (`--match` filter)
2. `Network.enable` and `Page.enable` on the tab
3. `Network.getAllCookies`, filter to `figma.com`
4. `Page.reload` to trigger fresh WebSocket handshakes
5. Listen for `Network.webSocketCreated`, `Network.webSocketWillSendHandshakeRequest`, `Network.webSocketHandshakeResponseReceived`, `Network.webSocketFrame{Sent,Received}`
6. Wait 5s for the handshakes to settle, dump everything to JSON

## When to re-run

Run once per file or whenever the cookie session expires. Cookies typically last weeks. The multiplayer URL pattern is stable per file (only `tracking_session_id` changes per connection, and the standalone client rotates that itself).

### Failure modes

If the recon shows zero binary frames on the multiplayer socket, Figma's session is degraded — close and reopen the tab in Chrome.

If the cookies list is shorter than ~15 entries, you may not actually be logged in to figma.com.
