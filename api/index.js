import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
	process.env.SUPABASE_URL,
	process.env.SUPABASE_KEY
)

const TIMEOUT_MS = 60000
const AUTH_KEY = process.env.AUTH_KEY

export default async function handler(req, res) {
	res.setHeader('Access-Control-Allow-Origin', '*')
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
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
	
	async function calculateCurrentTime(player) {
		if (player.time_remaining <= 0) return 0
		const elapsed = (now - player.last_time_update) / 1000
		return Math.max(0, player.time_remaining - elapsed)
	}
	
	async function cleanupPlayers() {
		const { data: players } = await supabase.from('players').select('*')
		if (!players) return
		
		for (const p of players) {
			const updates = {}
			const timeSinceLastSeen = now - p.last_seen
			
			// Only timeout online players who aren't in rejoin state
			if (p.status === 'online' && timeSinceLastSeen > TIMEOUT_MS) {
				updates.status = 'disconnected'
				updates.error_msg = 'Connection Timeout'
				updates.disconnected_at = now
			}
			
			// CRITICAL FIX: Don't delete disconnected players who are waiting for rejoin
			// If should_rejoin is true, keep them around indefinitely
			if (p.status === 'disconnected' && !p.should_rejoin) {
				// Only clean up disconnected players after 24 hours (not in rejoin state)
				const timeSinceDisconnect = now - (p.disconnected_at || p.last_seen)
				const CLEANUP_THRESHOLD = 24 * 60 * 60 * 1000 // 24 hours
				
				if (timeSinceDisconnect > CLEANUP_THRESHOLD) {
					// Actually delete them from database
					await supabase.from('players').delete().eq('user_id', p.user_id)
					continue // Skip time update for deleted players
				}
			}
			
			const newTime = await calculateCurrentTime(p)
			if (newTime !== p.time_remaining) {
				updates.time_remaining = newTime
				updates.last_time_update = now
			}
			
			if (Object.keys(updates).length > 0) {
				await supabase.from('players').update(updates).eq('user_id', p.user_id)
			}
		}
	}
	
	if (path === '/api/heartbeat' && req.method === 'POST') {
		const { username, userId } = body
		if (!username || !userId) return res.status(400).json({ error: 'Missing fields' })
		
		const { data: existing } = await supabase.from('players').select('*').eq('user_id', userId).single()
		
		if (!existing) {
			await supabase.from('players').insert({
				user_id: userId,
				username,
				status: 'online',
				should_rejoin: false,
				time_remaining: 0,
				selected_script: 'none',
				last_seen: now,
				last_time_update: now,
				first_seen: now
			})
			return res.status(200).json({ success: true, shouldRejoin: false })
		}
		
		// FIX #1: Only block if there's a CURRENT session conflict
		// If should_rejoin is true, this is an intentional reconnect - allow it
		if (existing.status === 'disconnected' && 
		    existing.error_msg && 
		    existing.error_msg.includes('joined a game from another device') &&
		    !existing.should_rejoin) {
			// Player is trying to connect while another session exists
			await supabase.from('players').update({ last_seen: now }).eq('user_id', userId)
			return res.status(403).json({ 
				success: false, 
				blocked: true,
				shouldRejoin: false
			})
		}
		
		const newTime = await calculateCurrentTime(existing)
		
		// FIX #2: Clear rejoin state and error when successfully reconnecting
		await supabase.from('players').update({
			username,
			status: 'online',
			last_seen: now,
			last_time_update: now,
			should_rejoin: false, // Clear rejoin flag
			time_remaining: newTime,
			error_msg: null, // Clear error
			disconnected_at: null
		}).eq('user_id', userId)
		
		return res.status(200).json({ 
			success: true, 
			shouldRejoin: existing.should_rejoin // Tell client if this was a rejoin
		})
	}
	
	if (path === '/api/players' && req.method === 'GET') {
		await cleanupPlayers()
		
		const { data: players } = await supabase.from('players').select('*').order('first_seen', { ascending: false })
		
		const playersObj = {}
		if (players) {
			for (const p of players) {
				const currentTime = await calculateCurrentTime(p)
				playersObj[p.user_id] = {
					username: p.username,
					userId: p.user_id,
					status: p.status,
					shouldRejoin: p.should_rejoin,
					timeRemaining: currentTime,
					selectedScript: p.selected_script,
					lastSeen: p.last_seen,
					lastTimeUpdate: p.last_time_update,
					firstSeen: p.first_seen,
					errorMsg: p.error_msg,
					disconnectedAt: p.disconnected_at
				}
			}
		}
		
		return res.status(200).json({ players: playersObj })
	}
	
	if (path === '/api/auth' && req.method === 'POST') {
		const { key } = body
		if (key === AUTH_KEY) {
			return res.status(200).json({ success: true })
		}
		return res.status(401).json({ error: 'Invalid key' })
	}
	
	if (path === '/api/rejoin' && req.method === 'POST') {
		const { userId } = body
		if (!userId) return res.status(400).json({ error: 'Missing userId' })
		
		// Set rejoin flag - player will stay in disconnected state until they actually reconnect
		const { error } = await supabase.from('players').update({ 
			should_rejoin: true,
			// Update last_seen so they don't get cleaned up while waiting
			last_seen: now
		}).eq('user_id', userId)
		
		if (error) return res.status(404).json({ error: 'Player not found' })
		return res.status(200).json({ success: true })
	}
	
	if (path === '/api/report' && req.method === 'POST') {
		const { username, userId, errorMsg } = body
		if (!username || !userId) return res.status(400).json({ error: 'Missing fields' })
		
		// FIX #3: Same-account disconnects should be treated as rejoinable
		const isSameAccountKick = errorMsg && errorMsg.includes('joined a game from another device')
		
		const { data: existing } = await supabase.from('players').select('*').eq('user_id', userId).single()
		
		if (existing) {
			await supabase.from('players').update({
				status: 'disconnected',
				error_msg: errorMsg,
				disconnected_at: now,
				last_seen: now,
				should_rejoin: isSameAccountKick // CRITICAL FIX: Mark as rejoinable
			}).eq('user_id', userId)
		} else {
			await supabase.from('players').insert({
				user_id: userId,
				username,
				status: 'disconnected',
				error_msg: errorMsg,
				last_seen: now,
				last_time_update: now,
				should_rejoin: isSameAccountKick, // CRITICAL FIX: Mark as rejoinable
				disconnected_at: now,
				time_remaining: 0,
				selected_script: 'none',
				first_seen: now
			})
		}
		
		return res.status(200).json({ success: true })
	}
	
	if (path === '/api/update-time' && req.method === 'POST') {
		const { userId, timeToAdd } = body
		if (!userId || timeToAdd === undefined) {
			return res.status(400).json({ error: 'Missing fields' })
		}
		
		const { data: player } = await supabase.from('players').select('time_remaining, last_time_update').eq('user_id', userId).single()
		
		if (!player) return res.status(404).json({ error: 'Player not found' })
		
		const currentTime = await calculateCurrentTime(player)
		const newTime = currentTime + timeToAdd
		
		await supabase.from('players').update({
			time_remaining: newTime,
			last_time_update: now
		}).eq('user_id', userId)
		
		return res.status(200).json({ success: true, timeRemaining: newTime })
	}
	
	if (path === '/api/update-script' && req.method === 'POST') {
		const { userId, script } = body
		if (!userId || !script) {
			return res.status(400).json({ error: 'Missing fields' })
		}
		
		const { error } = await supabase.from('players').update({ selected_script: script }).eq('user_id', userId)
		
		if (error) return res.status(404).json({ error: 'Player not found' })
		return res.status(200).json({ success: true })
	}
	
	if (path === '/api/script' && req.method === 'GET') {
		const { data: scriptData } = await supabase.from('scripts').select('content').eq('name', 'main').single()
		
		if (!scriptData || !scriptData.content) {
			return res.status(404).send('')
		}
		
		const serverUrl = req.headers.host ? 'https://' + req.headers.host : 'https://cloudsync-rho.vercel.app'
		const luaScript = scriptData.content.replace('{{SERVER_URL}}', serverUrl)
		
		res.setHeader('Content-Type', 'text/plain')
		return res.status(200).send(luaScript)
	}
	
	return res.status(404).json({ error: 'Not found' })
}
