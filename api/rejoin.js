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

  const { userId } = req.body;

  if (!userId || !players[userId]) {
    return res.status(404).json({ error: 'Player not found' });
  }

  players[userId].shouldRejoin = true;

  console.log(`Rejoin triggered for: ${players[userId].username}`);

  res.status(200).json({ 
    success: true,
    player: players[userId]
  });
}
