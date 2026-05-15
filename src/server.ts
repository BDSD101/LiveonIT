import http, { IncomingMessage, ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { handler } from './functions/api';

const PORT = Number(process.env.PORT) || 3000;

const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // Static file serving from the 'frontend' directory
  if (req.method === 'GET' || req.method === 'HEAD') {
    const rawUrl = req.url || '/';
    const urlPath = rawUrl === '/' ? '/index.html' : rawUrl.split('?')[0];
    const relativePath = urlPath.startsWith('/') ? urlPath.slice(1) : urlPath;
    const filePath = path.join(__dirname, '../frontend', relativePath);

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
          '.json': 'application/json',
          '.geojson': 'application/geo+json',
          '.csv': 'text/csv',
        };

        const content = fs.readFileSync(filePath);
        const contentType = mimeTypes[ext] || 'text/plain';

        // Compressible text types get gzip
        const compressible = ['.html', '.js', '.css', '.json', '.geojson', '.csv', '.svg'];
        const acceptsGzip = (req.headers['accept-encoding'] || '').includes('gzip');

        // Cache static assets: 1 hour for HTML, 1 day for others
        const cacheControl = ext === '.html'
          ? 'no-cache, no-store, must-revalidate'
          : 'public, max-age=86400';

        if (compressible.includes(ext) && acceptsGzip) {
          const compressed = zlib.gzipSync(content);
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Encoding': 'gzip',
            'Cache-Control': cacheControl,
            'Vary': 'Accept-Encoding',
          });
          res.end(compressed);
        } else {
          res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': cacheControl,
          });
          res.end(content);
        }
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

      const acceptsGzip = (req.headers['accept-encoding'] || '').includes('gzip');
      const responseBody = result.body || '';

      if (acceptsGzip && responseBody.length > 1024) {
        const compressed = zlib.gzipSync(Buffer.from(responseBody));
        responseHeaders['Content-Encoding'] = 'gzip';
        responseHeaders['Vary'] = 'Accept-Encoding';
        res.writeHead(result.statusCode, responseHeaders);
        res.end(compressed);
      } else {
        res.writeHead(result.statusCode, responseHeaders);
        res.end(responseBody);
      }
    } catch (err) {
      console.error(`API Error [${req.method}] ${req.url}:`, err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server → http://0.0.0.0:${PORT}`);
});
