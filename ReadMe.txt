Secure Voice App — Signaling Server

Overview
- This repository contains a simple Node.js signaling server used by the Secure Voice App client (in the `public/` folder).

Prerequisites
- Node.js installed and available in your PATH.
- (Optional) ngrok installed if you need to expose the server to the public internet.

Quick start
1. Install dependencies (if any are used by the project):

```bash
npm install
```

2. Start the signaling server from the project directory:

```bash
node server.js
```

3. (Optional) Expose the local server with ngrok so remote peers can connect:

```bash
ngrok http <port>
```

Replace `<port>` with the port your server is listening on (for example `3000`). Copy the public URL ngrok provides and use it for client signaling.

Troubleshooting
- If the server doesn't start, confirm Node.js is installed and that `server.js` is present.
- If clients cannot connect through ngrok, verify the correct port was used and that any firewall rules allow connections.

Contact / Notes
- The client UI is located in the `public/` folder. Update the client to point to the correct signaling URL when using ngrok.

---
This README focuses on starting and exposing the signaling server. Ask me to expand it with examples, environment variables, or a `npm` script if you want.