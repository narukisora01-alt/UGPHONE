// api/heartbeat.js
const players = global.players || (global.players = {});

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Roblox-Id');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { username, userId } = req.body;
    
    if (!username || !userId) {
      return res.status(400).json({ error: 'Missing required fields' });
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
    
    Object.keys(players).forEach(id => {
      if (now - players[id].lastSeen > 30000 && players[id].status === 'online') {
        delete players[id];
      }
    });
    
    return res.status(200).json({ 
      success: true,
      message: 'Heartbeat received'
    });
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' });
  }
}
