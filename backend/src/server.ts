import http from 'http';
import { handler } from './functions/api';

const PORT = 4000;

const server = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];

  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const body = chunks.length ? Buffer.concat(chunks).toString() : null;

    const url = new URL(req.url || '/', `http://localhost:${PORT}`);

    const queryStringParameters: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      queryStringParameters[key] = value;
    });

    const event = {
      httpMethod: req.method || 'GET',
      path: url.pathname,
      headers: req.headers as Record<string, string>,
      queryStringParameters: Object.keys(queryStringParameters).length
        ? queryStringParameters
        : null,
      body: body || null,
    } as any;

    try {
      const result = await handler(event);
      res.writeHead(result.statusCode, {
        ...result.headers,
        'Content-Type': 'application/json',
      });
      res.end(result.body);
    } catch (err) {
      console.error(err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Server error' }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Local backend running → http://localhost:${PORT}`);
  console.log(`Health check → http://localhost:${PORT}/health`);
});
