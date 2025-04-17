
# MCP Connector

**MCP Connector** is a lightweight server that can run and manage multiple Model Context Protocol (MCP) servers, specifically designed to integrate with [TypingMind](https://www.typingmind.com/mcp). It provides an easy way to run MCP servers on your local computer or a remote server, making it possible to connect your custom AI models or tools with TypingMind through a simple REST API.

---

## How to Run on Your Local Device

You can quickly start the MCP Connector using `npx` (no install required):

```bash
npx @typingmind/mcp <auth-token>
```
- Replace `<auth-token>` with your authentication token provided by TypingMind.

Keep this terminal window open while you use TypingMind.

---

## How to Run on a Server

If you prefer running the MCP Connector on a remote server:

1. **Install Node.js** (version 14 or later).
2. Run the server using `npx`:

   ```bash
   npx @typingmind/mcp <auth-token>
   ```

   Alternatively, for persistent running (e.g., after closing SSH), you may use a process manager like [pm2](https://pm2.keymetrics.io/) or `screen`/`tmux`:
   ```bash
   pm2 start npx -- @typingmind/mcp <auth-token>
   ```

---

## How to Connect to TypingMind

To connect MCP Connector to TypingMind:

1. Follow the instructions at [www.typingmind.com/mcp](https://www.typingmind.com/mcp).
2. Paste your MCP Connector server address (`http://localhost:<port>` or your server’s IP address and port) and your authentication token on the TypingMind MCP integration page.

---

## REST API Endpoints

All API endpoints require authentication via the Bearer token you provide when starting the server.

| Endpoint                       | Method | Description                                      |
|---------------------------------|--------|--------------------------------------------------|
| `/ping`                        | GET    | Health check; returns `{ status: "ok" }`         |
| `/start`                       | POST   | Start one or more MCP clients; body: `{ mcpServers: { ... } }` |
| `/restart/:id`                 | POST   | Restart a specific client                        |
| `/clients`                     | GET    | List all running MCP clients and their tools     |
| `/clients/:id`                 | GET    | Get info about a specific client                 |
| `/clients/:id/tools`           | GET    | List available tools for a client                |
| `/clients/:id/call_tools`      | POST   | Call a tool for a client; body: `{ name, arguments }` |
| `/clients/:id`                 | DELETE | Stop and delete a client                         |

**Notes:**  
- All requests need an `Authorization: Bearer <auth-token>` header.
- Available ports: The server will choose a free port from `50880`–`50889`.

---

## License

MIT
