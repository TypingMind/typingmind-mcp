# MCP Connector

**MCP Connector** is a lightweight server that can run and manage multiple Model Context Protocol (MCP) servers, specifically designed to integrate with [TypingMind](https://www.typingmind.com/mcp). It provides an easy way to run MCP servers on your local computer or a remote server, making it possible to connect your custom AI models or tools with TypingMind through a simple REST API.

---

## How to Run on Your Local Device

You can quickly start the MCP Connector using `npx` (no install required):

```bash
npx @typingmind/mcp@latest <auth-token>
```
- Replace `<auth-token>` with your authentication token provided by TypingMind.

You can also provide the auth token via an environment variable:

```bash
MCP_AUTH_TOKEN=<auth-token> npx @typingmind/mcp@latest
```

Keep the process running while you use TypingMind.

### HTTPS Support

To enable HTTPS, set the following environment variables:

```bash
CERTFILE=./path/to/certificate.crt KEYFILE=./path/to/privatekey.key npx @typingmind/mcp@latest <auth-token>
```

- `CERTFILE`: Path to your SSL certificate file
- `KEYFILE`: Path to your SSL private key file

When both variables are set, the server will use HTTPS instead of HTTP.

---

## How to Run on a Server

If you prefer running the MCP Connector on a remote server:

1. **Install Node.js** (version 14 or later).
2. Run the server using `npx`:

   ```bash
   npx @typingmind/mcp@latest <auth-token>
   ```

   To run with HTTPS:
   ```bash
   CERTFILE=./path/to/certificate.crt KEYFILE=./path/to/privatekey.key npx @typingmind/mcp@latest <auth-token>
   ```

   Alternatively, for persistent running (e.g., after closing SSH), you may use a process manager like [pm2](https://pm2.keymetrics.io/) or `screen`/`tmux`:
   ```bash
   pm2 start npx -- @typingmind/mcp@latest <auth-token>
   ```

---

## How to Run with Docker

You can also run the MCP Connector using Docker.

1.  **Build the Docker Image:**
    Navigate to the project's root directory (where the `Dockerfile` is located) and run:
    ```bash
    docker build -t mcp-connector .
    ```
    *(You can replace `mcp-connector` with your preferred image tag.)*

2.  **Run the Docker Container:**

    *   **Basic Run (HTTP):**
        Replace `<auth-token>` with your actual token. This command runs the container in detached mode (`-d`) and maps the container's default port `50880` to the same port on your host machine.
        ```bash
        docker run -d -p 50880:50880 --name mcp-connector-instance mcp-connector <auth-token>
        ```

    *   **Using a Different Port:**
        If you need to use a different port (e.g., 8080 on the host mapped to 12345 in the container), use the `-p` flag for mapping and the `-e PORT` environment variable:
        ```bash
        docker run -d -p 8080:12345 -e PORT=12345 --name mcp-connector-instance mcp-connector <auth-token>
        ```

    *   **Running with HTTPS:**
        To enable HTTPS, you need to provide the certificate and key files and set the `CERTFILE` and `KEYFILE` environment variables. Mount your host's certificate files into the container (e.g., into a `/certs` directory) and provide the paths via environment variables. Remember to map the appropriate port.
        ```bash
        docker run -d \
          -p 50880:50880 \
          -e PORT=50880 \
          -e CERTFILE=/certs/certificate.crt \
          -e KEYFILE=/certs/privatekey.key \
          -v /path/to/your/certificate.crt:/certs/certificate.crt:ro \
          -v /path/to/your/privatekey.key:/certs/privatekey.key:ro \
          --name mcp-connector-instance \
          mcp-connector <auth-token>
        ```
        *(Replace `/path/to/your/certificate.crt` and `/path/to/your/privatekey.key` with the actual paths on your host machine. The `:ro` flag mounts them as read-only.)*

    *   **Viewing Logs:**
        To see the logs from the running container:
        ```bash
        docker logs mcp-connector-instance
        ```

    *   **Stopping the Container:**
        ```bash
        docker stop mcp-connector-instance
        ```

    *   **Removing the Container:**
        ```bash
        docker rm mcp-connector-instance
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
| `/mcp-connect`                 | POST   | Proxy fetch requests; body: `{ url, options? }`  |

**Notes:**  
- All requests need an `Authorization: Bearer <auth-token>` header.
- Available ports: The server will choose port `50880` or `50881`, make sure
these ports are available in your system. You can also use `PORT` environment
variable to specify a different port.

### `/mcp-connect` Endpoint

The `/mcp-connect` endpoint acts as a proxy for fetch requests, allowing you to make HTTP requests through the MCP Connector server. This is useful for connecting to remote MCP servers or making cross-origin requests.

**Request Body:**
- `url` (required): The URL to fetch
- `options` (optional): Fetch options object (method, headers, body, etc.)

**Response:**
- The endpoint streams the response from the target URL, including status code, headers, and body
- Certain headers are filtered out to prevent decoding issues (Content-Encoding, Content-Length, Transfer-Encoding, and CORS headers)
- All proxied headers are exposed via `Access-Control-Expose-Headers` for CORS compatibility

**Example:**
```bash
curl -X POST http://localhost:50880/mcp-connect \
  -H "Authorization: Bearer <auth-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/api/endpoint",
    "options": {
      "method": "POST",
      "headers": {
        "Content-Type": "application/json"
      },
      "body": "{\"key\": \"value\"}"
    }
  }'
```

---

## License

MIT
