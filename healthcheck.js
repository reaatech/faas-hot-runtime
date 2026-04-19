#!/usr/bin/env node
const http = require('http');

const host = process.env.MCP_HOST || 'localhost';
const port = parseInt(process.env.MCP_PORT || '8080', 10);
const endpoint = process.env.HEALTH_ENDPOINT || '/health';

function checkHealth() {
  return new Promise((resolve) => {
    const req = http.request({ hostname: host, port, path: endpoint, method: 'GET' }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

checkHealth()
  .then((healthy) => {
    if (healthy) {
      console.log('Health check passed');
      process.exit(0);
    } else {
      console.error('Health check failed');
      process.exit(1);
    }
  })
  .catch(() => {
    console.error('Health check error');
    process.exit(1);
  });