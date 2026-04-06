# figma-kiwi-protocol — lat.md index

Knowledge base for the reverse-engineered Figma binary multiplayer protocol. Documents the read path (CDP capture) and the write path (standalone Node WebSocket client) plus the wire format that ties them together.

- [[architecture]] — project layout, goals, and the discoveries that unlocked write support
- [[wire-protocol]] — Figma multiplayer wire format: envelope, sessionID/ackID, nodeChanges
- [[capture]] — CDP-attached read path (bin/capture.mjs, bin/decode-frames.mjs)
- [[recon-handshake]] — one-shot CDP recon to extract cookies + multiplayer URL
- [[standalone-client]] — Node-side WebSocket client that bypasses Chrome at runtime
- [[auto-layout]] — Figma's `stack*` field vocabulary mapped to plugin-API names
