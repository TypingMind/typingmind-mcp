const express = require('express');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const {
  SSEClientTransport,
} = require('@modelcontextprotocol/sdk/client/sse.js');
const stringify = require('json-stable-stringify');
const cors = require('cors');
const fs = require('fs');
const https = require('https');
const { Readable } = require('stream');
const { findAvailablePort } = require('./port-finder');
const { authMiddleware } = require('./auth');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StdioClientTransport,
  getDefaultEnvironment,
} = require('@modelcontextprotocol/sdk/client/stdio.js');

// Store active MCP clients
const clients = new Map();

const createRemoteClient = async ({ clientId, url }) => {
  let client = undefined;
  const baseUrl = new URL(url);
  try {
    client = new Client({
      name: `mcp-streamable-http-bridge-${clientId}`,
      version: '1.0.0',
    });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);
    console.log('Connected using Streamable HTTP transport');
  } catch (error) {
    // If that fails with a 4xx error, try the older SSE transport
    console.log(
      'Streamable HTTP connection failed, falling back to SSE transport',
    );
    client = new Client({
      name: `mcp-sse-http-bridge-${clientId}`,
      version: '1.0.0',
    });
    const sseTransport = new SSEClientTransport(baseUrl);
    await client.connect(sseTransport);
    console.log('Connected using SSE transport');
  }

  return client;
};

// Helper function to start a client with given configuration
async function startClient(clientId, config) {
  const { command, url, args = [], env = {} } = config;

  if (!command && !url) {
    throw new Error('command or url is required');
  }

  let client;

  if (command) {
    // Create transport for the MCP client
    const transport = new StdioClientTransport({
      command,
      args,
      env:
        Object.values(env).length > 0
          ? {
              // see https://github.com/modelcontextprotocol/typescript-sdk/issues/216
              ...getDefaultEnvironment(),
              ...env,
            }
          : undefined, // cannot be {}, it will cause error
    });

    // Create and initialize the client
    client = new Client({
      name: `mcp-http-bridge-${clientId}`,
      version: '1.0.0',
    });

    // Connect the client to the transport
    await client.connect(transport);
  } else if (url) {
    client = await createRemoteClient({ clientId, url });
  } else {
    throw new Error('Either command or url must be provided');
  }

  // Store the client with its ID
  clients.set(clientId, {
    id: clientId,
    client,
    command,
    args,
    env,
    config, // Store original config for restart
    createdAt: new Date(),
  });

  return {
    id: clientId,
    message: 'MCP client started successfully',
  };
}

/**
 * Start the MCP server
 * @param {string} authToken Authentication token
 * @returns {Promise<{port: number}>} The port the server is running on
 */
async function start(authToken) {
  const app = express();
  app.set('trust proxy', true);

  const toolCallTimeout = process.env.TIMEOUT
    ? parseInt(process.env.TIMEOUT)
    : 60_000;

  // Find an available port
  const port = process.env.PORT || (await findAvailablePort());
  if (!port) {
    throw new Error(
      'No available ports found. Please specify a port by using the PORT environment variable.',
    );
  }

  // Configure middleware
  app.use(cors());
  app.use(express.json());

  // Add authentication to all endpoints
  const auth = authMiddleware(authToken);

    // --- FILE MANAGEMENT ---
  const path = require('path');
  const STORAGE_BASE_DIR = process.env.STORAGE_BASE_DIR || process.cwd();

  // Helper to resolve paths safely and prevent path traversal
  const getSafePath = (requestedPath) => {
    const normalizedPath = path.normalize(requestedPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const fullPath = path.join(STORAGE_BASE_DIR, normalizedPath);
    if (!fullPath.startsWith(path.resolve(STORAGE_BASE_DIR))) {
      throw new Error('Access denied: Path is outside storage directory');
    }
    return fullPath;
  };

  // 1. DOWNLOAD: GET /files/*
  app.get('/files/*', (req, res) => {
    const filename = req.params[0];
    const token = req.query.token;

    if (!token || token !== authToken) {
      return res.status(401).json({ error: 'Invalid or missing token' });
    }
    
    try {
      const safePath = getSafePath(filename);
      if (!fs.existsSync(safePath)) {
        return res.status(404).json({ error: 'File not found in storage.' });
      }
      res.download(safePath, path.basename(filename));
    } catch (e) {
      res.status(403).json({ error: e.message });
    }
  });

  // 2. DELETE: DELETE /files/*
  app.delete('/files/*', auth, (req, res) => {
    const filename = req.params[0];
    
    try {
      const safePath = getSafePath(filename);
      if (!fs.existsSync(safePath)) {
        return res.status(404).json({ error: 'File not found.' });
      }
      fs.unlinkSync(safePath);
      res.status(200).json({ message: `File ${filename} deleted successfully.` });
    } catch (e) {
      res.status(500).json({ error: 'Operation failed', details: e.message });
    }
  });

  // 3. UPLOAD: POST /upload
  app.post('/upload', auth, (req, res) => {
    const filename = req.headers['x-filename'];
    
    if (!filename) {
      return res.status(400).json({ error: 'X-Filename header is required.' });
    }

    try {
      const safePath = getSafePath(filename);
      
      // Ensure subdirectories exist
      fs.mkdirSync(path.dirname(safePath), { recursive: true });
      
      const fileStream = fs.createWriteStream(safePath);
      req.pipe(fileStream);

      fileStream.on('finish', () => {
        res.status(200).json({ 
          message: `File ${filename} saved successfully.`,
          filename: filename 
        });
      });

      fileStream.on('error', (err) => {
        console.error("Upload error:", err);
        res.status(500).json({ error: 'Failed to write file to storage.' });
      });
    } catch (e) {
      res.status(403).json({ error: e.message });
    }
  });

  // 4. LIST: GET /list
  app.get('/list', auth, (req, res) => {
    const recursiveReaddir = (dir, fileList = []) => {
      try {
        const files = fs.readdirSync(dir);
        files.forEach(file => {
          const filePath = path.join(dir, file);
          const stats = fs.statSync(filePath);
          
          // Skip system/hidden directories
          if (file === 'node_modules' || file === '.git' || file.startsWith('.')) return;
          
          if (stats.isDirectory()) {
            recursiveReaddir(filePath, fileList);
          } else {
            // Return path relative to STORAGE_BASE_DIR
            fileList.push(path.relative(STORAGE_BASE_DIR, filePath));
          }
        });
      } catch (err) {
        console.error(`Error reading directory ${dir}:`, err);
      }
      return fileList;
    };

    try {
      const files = recursiveReaddir(STORAGE_BASE_DIR);
      res.status(200).json({ files });
    } catch (e) {
      console.error("List error:", e);
      res.status(500).json({ error: 'Failed to list files', details: e.message });
    }
  });
  // -----------------------------------------

  // Health check endpoint
  app.get('/ping', auth, (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Start MCP clients using Claude Desktop config format
  app.post('/start', auth, async (req, res) => {
    try {
      const { mcpServers } = req.body;

      const results = {
        success: [],
        errors: [],
      };

      // Process each server configuration
      const startPromises = Object.entries(mcpServers).map(
        async ([serverId, config]) => {
          try {
            // Check if this client already exists
            if (clients.has(serverId)) {
              const hasConfigChanged =
                stringify(clients.get(serverId).config) !== stringify(config);
              if (!hasConfigChanged) {
                return;
              }
              console.log('Restarting client with new config:', serverId);
              clients.get(serverId).client.close();
            }

            const result = await startClient(serverId, config);
            results.success.push(result);
          } catch (error) {
            console.error(`Failed to initialize client ${serverId}:`, error);
            results.errors.push({
              id: serverId,
              error: `Failed to initialize: ${error.message}`,
            });
          }
        },
      );

      // Wait for all clients to be processed
      await Promise.all(startPromises);

      // Return appropriate response
      if (results.errors.length === 0) {
        return res.status(201).json({
          message: 'All MCP clients started successfully',
          clients: results.success,
        });
      } else {
        return res.status(400).json({
          message: 'Some MCP clients failed to start',
          success: results.success,
          errors: results.errors,
        });
      }
    } catch (error) {
      console.error('Error starting clients:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Restart a specific client
  app.post('/restart/:id', auth, async (req, res) => {
    const { id } = req.params;
    const clientEntry = clients.get(id);

    if (!clientEntry) {
      return res.status(404).json({ error: 'Client not found' });
    }

    try {
      // Get the original configuration
      const config = clientEntry.config || {
        command: clientEntry.command,
        args: clientEntry.args,
        env: clientEntry.env,
      };

      // Close the existing client
      await clientEntry.client.close();
      clients.delete(id);

      // Start a new client with the same configuration
      const result = await startClient(id, config);

      return res.status(200).json({
        message: `Client ${id} restarted successfully`,
        client: result,
      });
    } catch (error) {
      console.error(`Error restarting client ${id}:`, error);
      return res.status(500).json({
        error: 'Failed to restart client',
        details: error.message,
      });
    }
  });

  app.get('/clients', auth, async (req, res) => {
    try {
      // Create an array of promises that will fetch tools for each client
      const clientDetailsPromises = Array.from(clients.values()).map(
        async (clientEntry) => {
          const { id, command, args, createdAt } = clientEntry;

          try {
            // Get tools for this client
            const result = await clientEntry.client.listTools();
            const tools = result.tools || [];

            // Extract just the tool names into an array
            const toolNames = tools.map((tool) => tool.name);

            return {
              id,
              command,
              args,
              createdAt,
              tools: toolNames,
            };
          } catch (error) {
            console.error(`Error getting tools for client ${id}:`, error);
            return {
              id,
              command,
              args,
              createdAt,
              tools: [],
              toolError: error.message,
            };
          }
        },
      );

      // Wait for all promises to resolve
      const clientsList = await Promise.all(clientDetailsPromises);

      res.status(200).json(clientsList);
    } catch (error) {
      console.error('Error fetching clients list:', error);
      res.status(500).json({
        error: 'Failed to retrieve clients list',
        details: error.message,
      });
    }
  });

  app.get('/clients/:id', auth, (req, res) => {
    const clientId = req.params.id;
    const clientEntry = clients.get(clientId);

    if (!clientEntry) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const { id, command, args, createdAt } = clientEntry;

    res.status(200).json({ id, command, args, createdAt });
  });

  // Get tools for a specific client
  app.get('/clients/:id/tools', auth, async (req, res) => {
    const { id } = req.params;
    const clientEntry = clients.get(id);

    if (!clientEntry) {
      return res.status(404).json({ error: 'Client not found' });
    }

    try {
      const result = await clientEntry.client.listTools();
      res.status(200).json(result.tools);
    } catch (error) {
      console.error(`Error getting tools for client ${id}:`, error);
      res.status(500).json({
        error: 'Failed to get tools',
        details: error.message,
      });
    }
  });

  // Call a tool for a specific client
  app.post('/clients/:id/call_tools', auth, async (req, res) => {
    const { id } = req.params;
    const { name, arguments: toolArgs } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Tool name is required' });
    }

    const clientEntry = clients.get(id);
    if (!clientEntry) {
      return res.status(404).json({ error: 'Client not found' });
    }

    try {
      const result = await clientEntry.client.callTool(
        {
          name,
          arguments: toolArgs || {},
        },
        undefined,
        {
          timeout: toolCallTimeout,
        },
      );

    // Transform MCP 'resource' items (Text -> Numbered Text, Binary -> Download Link)
    if (result && Array.isArray(result.content)) {
      result.content = result.content.map(item => {
        if (item.type === 'resource' && item.resource) {
          const { resource } = item;

          // Case A: Text content (Code, Markdown, etc.) - Add line numbers for AI context
          if (typeof resource.text === 'string') {
            const lines = resource.text.split('\n');
            const numberedText = lines
              .map((line, index) => {
                const lineNum = (index + 1).toString().padStart(4, ' ');
                return `${lineNum} | ${line}`;
              })
              .join('\n');

            return {
              type: 'text',
              text: numberedText
            };
          }

          // Case B: Binary content (Images, PDFs, etc.) - Save to storage and provide link
          if (resource.blob) {
            try {
              const uriParts = resource.uri.split('/');
              const originalName = uriParts[uriParts.length - 1] || 'file';
              const timestamp = Date.now();
              const fileName = `downloads/${timestamp}_${originalName}`;
              const safePath = getSafePath(fileName);

              fs.mkdirSync(path.dirname(safePath), { recursive: true });
              fs.writeFileSync(safePath, Buffer.from(resource.blob, 'base64'));

              const downloadUrl = `${req.protocol}://${req.get('host')}/files/${fileName}?token=${authToken}`;
              return {
                type: 'text',
                text: `📂 **File Generated:** [Download ${originalName}](${downloadUrl})`
              };
            } catch (err) {
              console.error('Failed to save binary resource:', err);
              return {
                type: 'text',
                text: `⚠️ **Error:** Failed to save binary resource ${resource.uri}`
              };
            }
          }
        }
        return item;
      });
    }

    res.status(200).json(result);
  } catch (error) {
    console.error(`Error calling tool for client ${id}:`, error);
    res.status(500).json({
      error: 'Failed to call tool',
      details: error.message,
    });
  }
  });

  // Clean up resources for a client
  app.delete('/clients/:id', auth, async (req, res) => {
    const { id } = req.params;
    const clientEntry = clients.get(id);

    if (!clientEntry) {
      return res.status(404).json({ error: 'Client not found' });
    }

    try {
      // Close the client properly
      await clientEntry.client.close();
      clients.delete(id);

      res.status(200).json({ message: 'Client deleted successfully' });
    } catch (error) {
      console.error(`Error deleting client ${id}:`, error);
      res.status(500).json({
        error: 'Failed to delete client',
        details: error.message,
      });
    }
  });

  // MCP Connect endpoint - proxy fetch requests
  app.post('/mcp-connect', auth, async (req, res) => {
    try {
      const { url, options } = req.body;

      if (!url) {
        return res.status(400).json({ error: 'URL is required' });
      }

      // Make the fetch request
      const response = await fetch(url, options);

      // Filter out headers that can cause decoding issues when forwarding streams
      const headers = {};
      response.headers.forEach((value, key) => {
        const lowerKey = key.toLowerCase();
        // Skip headers that can cause content decoding errors:
        // - Content-Encoding: body stream may already be decompressed
        // - Content-Length: stream length may differ
        // - Transfer-Encoding: hop-by-hop header, shouldn't be forwarded
        // Skip CORS headers - these should be set by our server's CORS middleware, not proxied
        if (
          lowerKey !== 'content-encoding' &&
          lowerKey !== 'content-length' &&
          lowerKey !== 'transfer-encoding' &&
          !lowerKey.startsWith('access-control-')
        ) {
          headers[key] = value;
        }
      });

      // Forward status and headers (must be set before streaming)
      res.status(response.status);

      // Expose all proxied headers for CORS
      res.setHeader('Access-Control-Expose-Headers', '*');

      Object.keys(headers).forEach((key) => {
        res.setHeader(key, headers[key]);
      });

      // Stream the response body using Node.js Readable.fromWeb()
      if (response.body) {
        const nodeStream = Readable.fromWeb(response.body);
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      console.error('Error in mcp-connect:', error);
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Internal server error',
          details: error.message,
        });
      }
    }
  });

  // OPTIONS handler for mcp-connect CORS preflight
  app.options('/mcp-connect', auth, (req, res) => {
    res.status(204).end();
  });

  // Global error handler
  app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
      error: 'Internal server error',
      details: err.message,
    });
  });

  // Start the server (HTTP or HTTPS)
  return new Promise((resolve, reject) => {
    const host = process.env.HOSTNAME || '0.0.0.0';

    // Check if certificate and key files are specified
    const certFile = process.env.CERTFILE;
    const keyFile = process.env.KEYFILE;

    let server;

    if (certFile && keyFile) {
      try {
        // Read certificate files
        const httpsOptions = {
          cert: fs.readFileSync(certFile),
          key: fs.readFileSync(keyFile),
        };

        // Create HTTPS server
        server = https.createServer(httpsOptions, app);
        server.listen(port, host, () => {
          resolve({ port, host, protocol: 'https' });
        });
      } catch (error) {
        console.error('Error setting up HTTPS server:', error);
        reject(error);
      }
    } else {
      // Create HTTP server (fallback)
      server = app.listen(port, host, () => {
        resolve({ port, host, protocol: 'http' });
      });
    }

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\nShutting down MCP server...');
      server.close(() => {
        process.exit(0);
      });
    });
  });
}

// Graceful shutdown handling
process.on('SIGINT', async () => {
  console.log('Shutting down server...');

  // Close all clients
  for (const [id, clientEntry] of clients.entries()) {
    try {
      await clientEntry.client.close();
      console.log(`Closed client ${id}`);
    } catch (error) {
      console.error(`Error closing client ${id}:`, error);
    }
  }

  process.exit(0);
});

module.exports = {
  start,
};
