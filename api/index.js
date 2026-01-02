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

	if (req.method === 'OPTIONS') return res.status(200).end()

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

			if (p.status === 'online' && timeSinceLastSeen > TIMEOUT_MS) {
				updates.status = 'disconnected'
				updates.error_msg = 'Connection Timeout'
				updates.disconnected_at = now
			}

			if (p.status === 'disconnected' && !p.should_rejoin) {
				const timeSinceDisconnect = now - (p.disconnected_at || p.last_seen)
				const CLEANUP_THRESHOLD = 24 * 60 * 60 * 1000
				if (timeSinceDisconnect > CLEANUP_THRESHOLD) {
					await supabase.from('players').delete().eq('user_id', p.user_id)
					continue
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

		const { data: existing } = await supabase
			.from('players')
			.select('*')
			.eq('user_id', userId)
			.single()

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

		if (existing.status === 'disconnected') {
			if (existing.should_rejoin) {
				await supabase.from('players').update({ last_seen: now }).eq('user_id', userId)
				return res.status(200).json({
					success: true,
					shouldRejoin: true,
					stayDisconnected: true
				})
			}
			
			if (existing.error_msg && existing.error_msg.includes('joined a game from another device')) {
				await supabase.from('players').update({ last_seen: now }).eq('user_id', userId)
				return res.status(403).json({
					success: false,
					blocked: true,
					shouldRejoin: false
				})
			}
		}

		const newTime = await calculateCurrentTime(existing)

		await supabase.from('players').update({
			username,
			status: 'online',
			last_seen: now,
			last_time_update: now,
			should_rejoin: false,
			time_remaining: newTime,
			error_msg: null,
			disconnected_at: null
		}).eq('user_id', userId)

		return res.status(200).json({
			success: true,
			shouldRejoin: false
		})
	}

	if (path === '/api/players' && req.method === 'GET') {
		await cleanupPlayers()

		const { data: players } = await supabase
			.from('players')
			.select('*')
			.order('first_seen', { ascending: false })

		const playersObj = {}
		if (players) {
			for (const p of players) {
				playersObj[p.user_id] = {
					username: p.username,
					userId: p.user_id,
					status: p.status,
					shouldRejoin: p.should_rejoin,
					timeRemaining: await calculateCurrentTime(p),
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
		if (key === AUTH_KEY) return res.status(200).json({ success: true })
		return res.status(401).json({ error: 'Invalid key' })
	}

	if (path === '/api/rejoin' && req.method === 'POST') {
		const { userId } = body
		if (!userId) return res.status(400).json({ error: 'Missing userId' })

		await supabase.from('players').update({
			should_rejoin: true,
			last_seen: now
		}).eq('user_id', userId)

		return res.status(200).json({ success: true })
	}

	if (path === '/api/rejoin-complete' && req.method === 'POST') {
		const { userId } = body
		if (!userId) return res.status(400).json({ error: 'Missing userId' })

		await supabase.from('players').update({
			should_rejoin: false,
			status: 'online',
			error_msg: null,
			disconnected_at: null,
			last_seen: now
		}).eq('user_id', userId)

		return res.status(200).json({ success: true })
	}

	if (path === '/api/report' && req.method === 'POST') {
		const { username, userId, errorMsg } = body
		if (!username || !userId) return res.status(400).json({ error: 'Missing fields' })

		const { data: existing } = await supabase
			.from('players')
			.select('*')
			.eq('user_id', userId)
			.single()

		const currentTime = existing ? await calculateCurrentTime(existing) : 0

		if (existing) {
			await supabase.from('players').update({
				status: 'disconnected',
				error_msg: errorMsg,
				disconnected_at: now,
				last_seen: now,
				should_rejoin: false,
				time_remaining: currentTime,
				last_time_update: now
			}).eq('user_id', userId)
		} else {
			await supabase.from('players').insert({
				user_id: userId,
				username,
				status: 'disconnected',
				error_msg: errorMsg,
				last_seen: now,
				last_time_update: now,
				should_rejoin: false,
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
		if (!userId || timeToAdd === undefined) return res.status(400).json({ error: 'Missing fields' })

		const { data: player } = await supabase
			.from('players')
			.select('time_remaining, last_time_update')
			.eq('user_id', userId)
			.single()

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
		if (!userId || !script) return res.status(400).json({ error: 'Missing fields' })

		const { error } = await supabase
			.from('players')
			.update({ selected_script: script })
			.eq('user_id', userId)

		if (error) return res.status(404).json({ error: 'Player not found' })
		return res.status(200).json({ success: true })
	}

	if (path === '/api/script' && req.method === 'GET') {
		const { data: scriptData } = await supabase
			.from('scripts')
			.select('content')
			.eq('name', 'main')
			.single()

		if (!scriptData || !scriptData.content) return res.status(404).send('')

		const serverUrl = req.headers.host
			? 'https://' + req.headers.host
			: 'https://cloudsync-rho.vercel.app'

		const luaScript = scriptData.content.replace('{{SERVER_URL}}', serverUrl)

		res.setHeader('Content-Type', 'text/plain')
		return res.status(200).send(luaScript)
	}

	return res.status(404).json({ error: 'Not found' })
}
