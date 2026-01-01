// api/heartbeat.js
const players = global.players || (global.players = {});

export default function handler(req, res) {
  // CORS headers
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
    
    // Update or create player
    if (!players[userId]) {
      players[userId] = {
        username,
        userId,
        timestamp: now,
        status: 'online',
        shouldRejoin: false
      };
      console.log(`New player connected: ${username} (${userId})`);
    }
    
    players[userId].lastSeen = now;
    players[userId].status = 'online';
    
    // Clean up old players (offline for more than 30 seconds)
    Object.keys(players).forEach(id => {
      if (now - players[id].lastSeen > 30000 && players[id].status === 'online') {
        console.log(`Removing inactive player: ${players[id].username}`);
        delete players[id];
      }
    });
    
    return res.status(200).json({ 
      success: true,
      message: 'Heartbeat received'
    });
  } catch (error) {
    console.error('Heartbeat error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
