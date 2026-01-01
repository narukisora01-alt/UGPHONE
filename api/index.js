const players = {}
const TIMEOUT_MS = 10000
let lastCleanup = 0
const CLEANUP_INTERVAL = 2000

export default async function handler(req, res) {
	res.setHeader('Access-Control-Allow-Origin', '*')
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
	res.setHeader('Cache-Control', 'no-store')
	
	if (req.method === 'OPTIONS') {
		return res.status(200).end()
	}
	
	const path = req.url.split('?')[0]
	const now = Date.now()
	let body = {}
	
	if (req.method === 'POST') {
		try {
			body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}')
		} catch {
			body = {}
		}
	}
	
	function cleanupPlayers() {
		if (now - lastCleanup < CLEANUP_INTERVAL) return
		lastCleanup = now
		
		for (const id in players) {
			const p = players[id]
			
			if (p.status === 'online' && now - p.lastSeen > TIMEOUT_MS) {
				delete players[id]
			}
			
			if (p.status === 'disconnected' && now - p.disconnectedAt > 60000) {
				delete players[id]
			}
		}
	}
	
	if (path === '/api/heartbeat' && req.method === 'POST') {
		const { username, userId } = body
		if (!username || !userId) return res.status(400).json({ error: 'Missing fields' })
		
		if (!players[userId]) {
			players[userId] = {
				username,
				userId,
				status: 'online',
				shouldRejoin: false
			}
			players[userId].lastSeen = now
			cleanupPlayers()
			return res.status(200).json({ success: true })
		}
		
		if (players[userId].status === 'disconnected' && players[userId].errorMsg) {
			players[userId].lastSeen = now
			cleanupPlayers()
			return res.status(200).json({ 
				success: false, 
				blocked: true,
				error: players[userId].errorMsg 
			})
		}
		
		players[userId].username = username
		players[userId].status = 'online'
		players[userId].lastSeen = now
		players[userId].shouldRejoin = false
		delete players[userId].errorMsg
		delete players[userId].disconnectedAt
		
		cleanupPlayers()
		return res.status(200).json({ success: true })
	}
	
	if (path === '/api/players' && req.method === 'GET') {
		cleanupPlayers()
		return res.status(200).json({ players })
	}
	
	if (path === '/api/rejoin' && req.method === 'POST') {
		const { userId } = body
		if (!userId || !players[userId]) {
			return res.status(404).json({ error: 'Player not found' })
		}
		
		players[userId].shouldRejoin = true
		delete players[userId].errorMsg
		delete players[userId].disconnectedAt
		
		return res.status(200).json({ success: true })
	}
	
	if (path === '/api/report' && req.method === 'POST') {
		const { username, userId, errorMsg } = body
		if (!username || !userId) return res.status(400).json({ error: 'Missing fields' })
		
		if (!errorMsg || !errorMsg.includes('joined a game from another device')) {
			delete players[userId]
			return res.status(200).json({ success: true, ignored: true })
		}
		
		players[userId] = {
			username,
			userId,
			status: 'disconnected',
			errorMsg: errorMsg,
			lastSeen: now,
			shouldRejoin: false,
			disconnectedAt: now
		}
		
		return res.status(200).json({ success: true })
	}
	
	return res.status(404).json({ error: 'Not found' })
}
