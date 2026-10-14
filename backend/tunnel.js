const localtunnel = require('localtunnel');
const https = require('https');

async function getPublicIp() {
  return new Promise((resolve) => {
    https.get('https://api.ipify.org', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data.trim()));
    }).on('error', () => resolve(''));
  });
}

let currentTunnel = null;

async function startTunnel() {
  if (currentTunnel) {
    try { currentTunnel.close(); } catch {}
    currentTunnel = null;
  }
  try {
    const ip = await getPublicIp();
    const subdomain = 'carepoint-' + Math.floor(1000 + Math.random() * 9000);
    currentTunnel = await localtunnel({ port: 3001, subdomain });
    console.log('--------------------------------------------------');
    console.log('PUBLIC LIVE URL: ' + currentTunnel.url);
    if (ip) console.log('PASSWORD (IP): ' + ip);
    console.log('--------------------------------------------------');

    currentTunnel.on('close', () => {
      console.log('Tunnel disconnected. Reconnecting in 3 seconds...');
      setTimeout(startTunnel, 3000);
    });

    currentTunnel.on('error', (err) => {
      console.error('Tunnel error:', err.message);
      setTimeout(startTunnel, 3000);
    });
  } catch (err) {
    console.error('Could not start tunnel:', err.message);
    setTimeout(startTunnel, 5000);
  }
}

// Keep event loop active
setInterval(() => {}, 10000);

startTunnel();
