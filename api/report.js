const players = global.players || (global.players = {});

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { username, userId, errorMsg } = req.body;

  if (!username || !userId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Update player to disconnected
  players[userId] = {
    username,
    userId,
    errorMsg: errorMsg || 'Connection Lost',
    timestamp: players[userId]?.timestamp || Date.now(),
    lastSeen: Date.now(),
    status: 'disconnected',
    shouldRejoin: false
  };

  console.log(`Player disconnected: ${username} (${userId})`);

  res.status(200).json({ 
    success: true,
    message: 'Player reported as disconnected'
  });
}
