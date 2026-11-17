'use strict';

const net = require('node:net');

// Check this in both processes: a proxy or redirected host must never receive
// the repository credential. Git runs with LC_ALL=C so prompts are predictable.
function credentialKind(prompt) {
  const match = /^(Username|Password) for '(https:\/\/[^']+)':\s*$/.exec(prompt);
  if (!match) return null;
  try {
    const url = new URL(match[2]);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port ||
        url.password || (url.username && url.username !== 'x-access-token')) return null;
    return match[1];
  } catch { return null; }
}

function main() {
  const prompt = process.argv[2] || '';
  const socketPath = process.env.REPODRIVE_ASKPASS_SOCKET;
  if (!socketPath || !credentialKind(prompt)) { process.exitCode = 1; return; }
  const socket = net.createConnection(socketPath);
  let response = '';
  let done = false;
  const fail = () => { if (!done) process.exitCode = 1; socket.destroy(); };
  socket.on('error', fail);
  socket.on('connect', () => socket.end(`${JSON.stringify({ prompt })}\n`));
  socket.on('data', (chunk) => {
    response += chunk.toString('utf8');
    if (response.length > 65536) fail();
  });
  socket.on('end', () => {
    try {
      const { value } = JSON.parse(response);
      if (typeof value !== 'string' || /[\r\n\0]/.test(value)) return fail();
      done = true;
      process.stdout.write(`${value}\n`);
    } catch { fail(); }
  });
}

if (require.main === module) main();
module.exports = { credentialKind };
