// api/index.js - ONE FILE FOR ALL ENDPOINTS
const players = {};

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const path = req.url.split('?')[0];

  // HEARTBEAT
  if (path === '/api/heartbeat' && req.method === 'POST') {
    const { username, userId } = req.body;
    if (!username || !userId) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const now = Date.now();
    if (!players[userId]) {
      players[userId] = {
        username,
        userId,
        timestamp: now,
        status: 'online',
        shouldRejoin: false
      };
    }
    
    players[userId].lastSeen = now;
    players[userId].status = 'online';
    players[userId].shouldRejoin = false;

    // Cleanup old players
    Object.keys(players).forEach(id => {
      if (now - players[id].lastSeen > 30000) {
        delete players[id];
      }
    });

    return res.status(200).json({ success: true });
  }

  // GET PLAYERS
  if (path === '/api/players' && req.method === 'GET') {
    return res.status(200).json({ 
      players,
      count: Object.keys(players).length
    });
  }

  // REJOIN
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

  // REPORT DISCONNECT
  if (path === '/api/report' && req.method === 'POST') {
    const { username, userId, errorMsg } = req.body;
    if (!username || !userId) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    players[userId] = {
      username,
      userId,
      errorMsg: errorMsg || 'Connection Lost',
      timestamp: players[userId]?.timestamp || Date.now(),
      lastSeen: Date.now(),
      status: 'disconnected',
      shouldRejoin: false
    };

    return res.status(200).json({ success: true });
  }

  return res.status(404).json({ error: 'Not found' });
}
