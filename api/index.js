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
				p.status = 'disconnected'
				p.errorMsg = 'Connection Timeout'
				p.disconnectedAt = now
			}
			
			if (p.timeRemaining !== undefined && p.timeRemaining > 0) {
				const elapsed = (now - (p.lastTimeUpdate || p.lastSeen)) / 1000
				p.timeRemaining = Math.max(0, p.timeRemaining - elapsed)
				p.lastTimeUpdate = now
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
				shouldRejoin: false,
				timeRemaining: 0,
				selectedScript: 'none',
				lastSeen: now,
				lastTimeUpdate: now,
				firstSeen: now
			}
		} else {
			players[userId].username = username
			players[userId].status = 'online'
			players[userId].lastSeen = now
			players[userId].shouldRejoin = false
			
			if (players[userId].errorMsg === 'Connection Timeout') {
				delete players[userId].errorMsg
				delete players[userId].disconnectedAt
			}
		}
		
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
		
		return res.status(200).json({ success: true })
	}
	
	if (path === '/api/report' && req.method === 'POST') {
		const { username, userId, errorMsg } = body
		if (!username || !userId) return res.status(400).json({ error: 'Missing fields' })
		
		if (!errorMsg || !errorMsg.includes('joined a game from another device')) {
			return res.status(200).json({ success: true, ignored: true })
		}
		
		if (players[userId]) {
			if (players[userId].errorMsg !== 'Connection Timeout') {
				players[userId].status = 'disconnected'
				players[userId].errorMsg = errorMsg
				players[userId].disconnectedAt = now
			}
		} else {
			players[userId] = {
				username,
				userId,
				status: 'disconnected',
				errorMsg: errorMsg,
				lastSeen: now,
				lastTimeUpdate: now,
				shouldRejoin: false,
				disconnectedAt: now,
				timeRemaining: 0,
				selectedScript: 'none',
				firstSeen: now
			}
		}
		
		return res.status(200).json({ success: true })
	}
	
	if (path === '/api/update-time' && req.method === 'POST') {
		const { userId, timeToAdd } = body
		if (!userId || timeToAdd === undefined) {
			return res.status(400).json({ error: 'Missing fields' })
		}
		
		if (!players[userId]) {
			return res.status(404).json({ error: 'Player not found' })
		}
		
		players[userId].timeRemaining = (players[userId].timeRemaining || 0) + timeToAdd
		
		return res.status(200).json({ success: true, timeRemaining: players[userId].timeRemaining })
	}
	
	if (path === '/api/update-script' && req.method === 'POST') {
		const { userId, script } = body
		if (!userId || !script) {
			return res.status(400).json({ error: 'Missing fields' })
		}
		
		if (!players[userId]) {
			return res.status(404).json({ error: 'Player not found' })
		}
		
		players[userId].selectedScript = script
		
		return res.status(200).json({ success: true })
	}
	
	return res.status(404).json({ error: 'Not found' })
}
