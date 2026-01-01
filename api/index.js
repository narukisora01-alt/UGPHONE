const players = {};
const TIMEOUT_MS = 10000;
let lastCleanup = 0;
const CLEANUP_INTERVAL = 5000;

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const path = req.url.split('?')[0];
  const now = Date.now();

  function cleanupPlayers() {
    if (now - lastCleanup < CLEANUP_INTERVAL) return;
    
    lastCleanup = now;
    Object.keys(players).forEach(id => {
      const player = players[id];
      const timeSinceLastSeen = now - player.lastSeen;
      
      if (player.status === 'online' && timeSinceLastSeen > TIMEOUT_MS) {
        player.status = 'disconnected';
        player.errorMsg = 'Connection Timeout';
      }
    });
  }

  if (path === '/api/heartbeat' && req.method === 'POST') {
    const { username, userId } = req.body;
    
    if (!username || !userId) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    if (!players[userId]) {
      players[userId] = {
        username,
        userId,
        timestamp: now,
        status: 'online',
        shouldRejoin: false
      };
    } else {
      players[userId].username = username;
      players[userId].status = 'online';
      players[userId].shouldRejoin = false;
      delete players[userId].errorMsg;
    }
    
    players[userId].lastSeen = now;
    cleanupPlayers();
    
    return res.status(200).json({ 
      success: true,
      shouldRejoin: players[userId].shouldRejoin 
    });
  }

  if (path === '/api/players' && req.method === 'GET') {
    cleanupPlayers();
    return res.status(200).json({ 
      players,
      count: Object.keys(players).length
    });
  }

  if (path === '/api/rejoin' && req.method === 'POST') {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }
    
    if (!players[userId]) {
      return res.status(404).json({ error: 'Player not found' });
    }
    
    players[userId].shouldRejoin = true;
    
    return res.status(200).json({ success: true });
  }

  if (path === '/api/report' && req.method === 'POST') {
    const { username, userId, errorMsg } = req.body;
    
    if (!username || !userId) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    if (!players[userId]) {
      players[userId] = {
        username,
        userId,
        timestamp: now,
        lastSeen: now,
        status: 'disconnected',
        errorMsg: errorMsg || 'Connection Lost',
        shouldRejoin: false
      };
    } else {
      players[userId].status = 'disconnected';
      players[userId].errorMsg = errorMsg || 'Connection Lost';
      players[userId].lastSeen = now;
    }

    return res.status(200).json({ success: true });
  }

  return res.status(404).json({ error: 'Not found' });
}
