// Fake Telegram Bot API for the Docker tests. Records every call; GET /__calls returns them.
import { createServer } from 'node:http';

const calls = [];
let messageId = 1000;

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/__calls') return res.end(JSON.stringify(calls));
    const method = (req.url ?? '').split('/').pop() ?? '';
    const body = Buffer.concat(chunks);
    const ct = req.headers['content-type'] ?? '';
    const fields = {};
    try {
      if (ct.includes('multipart/form-data')) {
        const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': ct }, body }).formData();
        for (const [k, v] of form.entries()) fields[k] = typeof v === 'string' ? v : `<file ${v.size}>`;
      } else if (body.length) {
        for (const [k, v] of Object.entries(JSON.parse(body.toString('utf8')))) fields[k] = typeof v === 'string' ? v : JSON.stringify(v);
      }
    } catch {
      // keep what we have
    }
    calls.push({ method, at: Date.now(), fields });
    res.end(JSON.stringify({ ok: true, result: method.startsWith('send') ? { message_id: messageId++ } : true }));
  });
}).listen(8081, '0.0.0.0');
