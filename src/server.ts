import 'dotenv/config';
import http, { IncomingMessage, ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';
import { handler } from './functions/api';

const PORT = Number(process.env.PORT) || 3000;

const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // Static file serving from the 'frontend' directory
  if (req.method === 'GET') {
    const urlPath = req.url === '/' ? '/index.html' : req.url || '/index.html';
    const filePath = path.join(__dirname, '../frontend', urlPath);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      try {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.svg': 'image/svg+xml',
        };

        const content = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
        res.end(content);
        return;
      } catch (err) {
        console.error(`Failed to serve static file ${urlPath}:`, err);
        res.writeHead(500);
        res.end('Internal Server Error');
        return;
      }
    }
  }

  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', async () => {
    const body = chunks.length ? Buffer.concat(chunks).toString() : null;

    // Use localhost if host header is missing for URL parsing
    const host = req.headers.host || `localhost:${PORT}`;
    const url = new URL(req.url || '/', `http://${host}`);
    const queryStringParameters: Record<string, string> = {};
    url.searchParams.forEach((value: string, key: string) => { queryStringParameters[key] = value; });

    const event = {
      httpMethod: req.method || 'GET',
      path: url.pathname,
      headers: req.headers as Record<string, string>,
      queryStringParameters: Object.keys(queryStringParameters).length ? queryStringParameters : null,
      body: body || null,
    } as any;

    try {
      const result = await handler(event);
      const responseHeaders: any = {
        ...result.headers,
        'Content-Type': result.headers?.['Content-Type'] || 'application/json',
      };
      res.writeHead(result.statusCode, responseHeaders);
      res.end(result.body);
    } catch (err) {
      console.error(`API Error [${req.method}] ${req.url}:`, err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`LiveonIT Server → http://0.0.0.0:${PORT}`);
});
