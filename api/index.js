import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
	process.env.SUPABASE_URL,
	process.env.SUPABASE_KEY
)

const TIMEOUT_MS = 60000
const AUTH_KEY = process.env.AUTH_KEY

function generateKey() {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
	let key = 'CLOUDSYNC_'
	for (let i = 0; i < 16; i++) {
		key += chars.charAt(Math.floor(Math.random() * chars.length))
	}
	return key
}

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
		if (!player || player.time_remaining <= 0) return 0
		const last = player.last_time_update || now
		const elapsed = (now - last) / 1000
		return Math.max(0, player.time_remaining - elapsed)
	}

	async function calculateKeyTimeRemaining(key) {
		if (!key || !key.expires_at) return 0
		const remaining = (key.expires_at - now) / 1000
		return Math.max(0, remaining)
	}

	async function cleanupPlayers() {
		const { data: players } = await supabase.from('players').select('*')
		if (!players) return

		for (const p of players) {
			const updates = {}
			const lastSeen = p.last_seen || 0

			if (p.status === 'online' && now - lastSeen > TIMEOUT_MS && !p.should_rejoin) {
				updates.status = 'disconnected'
				updates.error_msg = 'Connection Timeout'
				updates.disconnected_at = now
			}

			if (p.status === 'disconnected' && !p.should_rejoin) {
				const since = now - (p.disconnected_at || lastSeen)
				if (since > 86400000) {
					await supabase.from('players').delete().eq('user_id', p.user_id)
					continue
				}
			}

			const newTime = await calculateCurrentTime(p)
			if (newTime !== p.time_remaining) {
				updates.time_remaining = newTime
				updates.last_time_update = now
			}

			if (Object.keys(updates).length) {
				await supabase.from('players').update(updates).eq('user_id', p.user_id)
			}
		}
	}

	async function checkKeyExpiry() {
		const { data: keys } = await supabase.from('keys').select('*').eq('status', 'active')
		if (!keys) return

		for (const key of keys) {
			if (key.expires_at && now > key.expires_at) {
				await supabase.from('keys').update({ status: 'expired' }).eq('key', key.key)
				
				const { data: players } = await supabase.from('players').select('*').eq('access_key', key.key)
				if (players) {
					for (const player of players) {
						await supabase.from('players').update({
							status: 'disconnected',
							error_msg: 'Your Key Has Expired!',
							disconnected_at: now
						}).eq('user_id', player.user_id)
					}
				}
			}
		}
	}

	if (path === '/api/create-key' && req.method === 'POST') {
		const { adminKey, duration, unit } = body
		
		if (!adminKey || adminKey !== AUTH_KEY) {
			return res.status(401).json({ success: false, error: 'Unauthorized' })
		}
		
		if (!duration || !unit) {
			return res.status(400).json({ success: false, error: 'Missing duration or unit' })
		}
		
		let seconds = duration * 60
		if (unit === 'hours') seconds = duration * 3600
		else if (unit === 'days') seconds = duration * 86400
		
		const key = generateKey()
		const durationText = `${duration} ${unit}`
		
		const { error } = await supabase.from('keys').insert({
			key,
			status: 'unused',
			duration: durationText,
			created_at: now,
			duration_seconds: seconds
		})
		
		if (error) {
			return res.status(500).json({ success: false, error: 'Failed to create key' })
		}
		
		return res.json({ success: true, key })
	}

	if (path === '/api/validate-key' && req.method === 'POST') {
		const { key } = body
		if (!key) return res.status(400).json({ success: false, error: 'Missing key' })
		
		if (key === AUTH_KEY) {
			return res.json({ success: true, isAdmin: true })
		}
		
		await checkKeyExpiry()
		
		const { data: keyData } = await supabase
			.from('keys')
			.select('*')
			.eq('key', key)
			.maybeSingle()
		
		if (!keyData) {
			return res.json({ success: false, message: 'Invalid key' })
		}
		
		if (keyData.status === 'expired') {
			return res.json({ success: false, message: 'Key has expired. Please contact the owner.' })
		}
		
		if (keyData.status === 'unused') {
			await supabase.from('keys').update({
				status: 'active',
				used_at: now,
				expires_at: now + (keyData.duration_seconds * 1000)
			}).eq('key', key)
		}
		
		return res.json({ success: true, isAdmin: false })
	}

	if (path === '/api/dashboard' && req.method === 'GET') {
		const key = req.url.split('key=')[1]?.split('&')[0]
		
		if (!key) {
			return res.status(401).json({ error: 'Unauthorized' })
		}
		
		const isAdmin = key === AUTH_KEY
		
		if (isAdmin) {
			await cleanupPlayers()
			
			const { data: players } = await supabase.from('players').select('*')
			const { data: allKeys } = await supabase.from('keys').select('*').order('created_at', { ascending: false })
			
			const playersFormatted = (players || []).map(p => ({
				username: p.username,
				userId: p.user_id,
				honey: p.honey || 0,
				pollen: p.pollen || 0,
				status: p.status,
				errorMsg: p.error_msg
			}))
			
			const keysFormatted = (allKeys || []).map(k => ({
				key: k.key,
				status: k.status,
				duration: k.duration,
				usedBy: k.used_by,
				expiresAt: k.expires_at
			}))
			
			return res.json({
				totalKeys: keysFormatted.length,
				activeKeys: keysFormatted.filter(k => k.status === 'active').length,
				totalPlayers: playersFormatted.length,
				players: playersFormatted,
				keys: keysFormatted
			})
		}
		
		await checkKeyExpiry()
		
		const { data: keyData } = await supabase
			.from('keys')
			.select('*')
			.eq('key', key)
			.maybeSingle()
		
		if (!keyData) {
			return res.status(401).json({ error: 'Invalid key' })
		}
		
		const { data: players } = await supabase
			.from('players')
			.select('*')
			.eq('access_key', key)
		
		const playersFormatted = (players || []).map(p => ({
			username: p.username,
			userId: p.user_id,
			honey: p.honey || 0,
			pollen: p.pollen || 0,
			status: p.status,
			errorMsg: p.error_msg
		}))
		
		const keyTimeRemaining = await calculateKeyTimeRemaining(keyData)
		
		return res.json({
			players: playersFormatted,
			keyTimeRemaining,
			expired: keyData.status === 'expired' || keyTimeRemaining <= 0
		})
	}

	if (path === '/api/add-key-time' && req.method === 'POST') {
		const { adminKey, key, duration, unit } = body
		
		if (!adminKey || adminKey !== AUTH_KEY) {
			return res.status(401).json({ success: false, error: 'Unauthorized' })
		}
		
		if (!key || !duration || !unit) {
			return res.status(400).json({ success: false, error: 'Missing required fields' })
		}
		
		let seconds = duration * 60
		if (unit === 'hours') seconds = duration * 3600
		else if (unit === 'days') seconds = duration * 86400
		
		const { data: keyData } = await supabase
			.from('keys')
			.select('*')
			.eq('key', key)
			.maybeSingle()
		
		if (!keyData) {
			return res.status(404).json({ success: false, error: 'Key not found' })
		}
		
		const newExpiry = (keyData.expires_at || now) + (seconds * 1000)
		const newDurationSeconds = keyData.duration_seconds + seconds
		
		const { error } = await supabase.from('keys').update({
			expires_at: newExpiry,
			status: 'active',
			duration_seconds: newDurationSeconds
		}).eq('key', key)
		
		if (error) {
			return res.status(500).json({ success: false, error: 'Failed to update key' })
		}
		
		return res.json({ success: true })
	}

	if (path === '/api/heartbeat' && req.method === 'POST') {
		const { username, userId, honey, pollen, accessKey } = body
		
		if (!username || !userId || !accessKey) {
			return res.status(400).json({ success: false, error: 'Missing fields' })
		}
		
		await checkKeyExpiry()
		
		const { data: keyData } = await supabase
			.from('keys')
			.select('*')
			.eq('key', accessKey)
			.maybeSingle()
		
		if (!keyData || keyData.status === 'expired') {
			return res.json({ success: false, kick: true, reason: 'Your Key Has Expired!' })
		}
		
		const { data: existing } = await supabase
			.from('players')
			.select('*')
			.eq('user_id', userId)
			.maybeSingle()

		if (!existing) {
			await supabase.from('players').insert({
				user_id: userId,
				username,
				access_key: accessKey,
				status: 'online',
				should_rejoin: false,
				time_remaining: 0,
				selected_script: 'atlas',
				last_seen: now,
				last_time_update: now,
				first_seen: now,
				honey: honey || 0,
				pollen: pollen || 0
			})
			
			await supabase.from('keys').update({
				used_by: username
			}).eq('key', accessKey)
			
			return res.json({ success: true, shouldRejoin: false })
		}

		const newTime = await calculateCurrentTime(existing)

		await supabase.from('players').update({
			username,
			status: 'online',
			last_seen: now,
			last_time_update: now,
			time_remaining: newTime,
			error_msg: null,
			disconnected_at: null,
			honey: honey || existing.honey || 0,
			pollen: pollen || existing.pollen || 0
		}).eq('user_id', userId)

		return res.json({
			success: true,
			shouldRejoin: existing.should_rejoin
		})
	}

	if (path === '/api/players' && req.method === 'GET') {
		await cleanupPlayers()

		const { data: players } = await supabase
			.from('players')
			.select('*')
			.order('first_seen', { ascending: false })

		const out = {}
		for (const p of players || []) {
			out[p.user_id] = {
				username: p.username,
				userId: p.user_id,
				status: p.status,
				shouldRejoin: !!p.should_rejoin,
				timeRemaining: await calculateCurrentTime(p),
				selectedScript: p.selected_script,
				lastSeen: p.last_seen,
				lastTimeUpdate: p.last_time_update,
				firstSeen: p.first_seen,
				errorMsg: p.error_msg,
				disconnectedAt: p.disconnected_at,
				honey: p.honey || 0,
				pollen: p.pollen || 0
			}
		}

		return res.json({ players: out })
	}

	if (path === '/api/auth' && req.method === 'POST') {
		return body.key === AUTH_KEY
			? res.json({ success: true })
			: res.status(401).json({ success: false, error: 'Invalid key' })
	}

	if (path === '/api/rejoin' && req.method === 'POST') {
		const { userId } = body
		if (!userId) return res.status(400).json({ success: false, error: 'Missing userId' })

		await supabase.from('players').update({
			should_rejoin: true,
			last_seen: now
		}).eq('user_id', userId)

		return res.json({ success: true })
	}

	if (path === '/api/rejoin-complete' && req.method === 'POST') {
		const { userId } = body
		if (!userId) return res.status(400).json({ success: false, error: 'Missing userId' })

		await supabase.from('players').update({
			should_rejoin: false,
			status: 'online',
			error_msg: null,
			disconnected_at: null,
			last_seen: now
		}).eq('user_id', userId)

		return res.json({ success: true })
	}

	if (path === '/api/report' && req.method === 'POST') {
		const { username, userId, errorMsg } = body
		if (!username || !userId) return res.status(400).json({ success: false, error: 'Missing fields' })

		const { data: existing } = await supabase
			.from('players')
			.select('*')
			.eq('user_id', userId)
			.maybeSingle()

		const currentTime = existing ? await calculateCurrentTime(existing) : 0

		if (existing) {
			await supabase.from('players').update({
				status: 'disconnected',
				error_msg: errorMsg,
				disconnected_at: now,
				last_seen: now,
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
				first_seen: now,
				honey: 0,
				pollen: 0
			})
		}

		return res.json({ success: true })
	}

	if (path === '/api/update-time' && req.method === 'POST') {
		const { userId, timeToAdd } = body
		if (!userId || typeof timeToAdd !== 'number') {
			return res.status(400).json({ success: false, error: 'Missing fields' })
		}

		const { data: player } = await supabase
			.from('players')
			.select('*')
			.eq('user_id', userId)
			.maybeSingle()

		if (!player) return res.status(404).json({ success: false, error: 'Player not found' })

		const current = await calculateCurrentTime(player)
		const newTime = Math.max(0, current + timeToAdd)

		await supabase.from('players').update({
			time_remaining: newTime,
			last_time_update: now
		}).eq('user_id', userId)

		return res.json({ success: true, timeRemaining: newTime })
	}

	if (path === '/api/update-script' && req.method === 'POST') {
		const { userId, script } = body
		if (!userId || !script) return res.status(400).json({ success: false, error: 'Missing fields' })

		await supabase.from('players')
			.update({ selected_script: script })
			.eq('user_id', userId)

		return res.json({ success: true })
	}

	if (path === '/api/script' && req.method === 'GET') {
		const { data } = await supabase
			.from('scripts')
			.select('content')
			.eq('name', 'main')
			.maybeSingle()

		if (!data?.content) return res.status(404).send('')

		const serverUrl = req.headers.host
			? 'https://' + req.headers.host
			: 'https://cloudsync-rho.vercel.app'

		res.setHeader('Content-Type', 'text/plain')
		return res.send(data.content.replace('{{SERVER_URL}}', serverUrl))
	}

	return res.status(404).json({ error: 'Not found' })
}
