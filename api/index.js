import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
	process.env.SUPABASE_URL,
	process.env.SUPABASE_KEY
)

const TIMEOUT_MS = 30000
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
	
	async function cleanupPlayers() {
		const { data: players } = await supabase
			.from('players')
			.select('*')
			.eq('status', 'online')
		
		if (!players) return
		
		for (const p of players) {
			const timeSinceLastSeen = now - p.last_seen
			
			if (timeSinceLastSeen > TIMEOUT_MS) {
				await supabase
					.from('players')
					.update({
						status: 'disconnected',
						error_msg: 'Connection Timeout',
						disconnected_at: now
					})
					.eq('user_id', p.user_id)
			}
			
			if (p.time_remaining > 0) {
				const elapsed = (now - p.last_time_update) / 1000
				const newTime = Math.max(0, p.time_remaining - elapsed)
				
				await supabase
					.from('players')
					.update({
						time_remaining: newTime,
						last_time_update: now
					})
					.eq('user_id', p.user_id)
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
		} else {
			const wasOnline = existing.status === 'online'
			const timeSinceLastSeen = (now - existing.last_seen) / 1000
			
			let newTime = existing.time_remaining
			if (!wasOnline && existing.time_remaining > 0 && timeSinceLastSeen < 60) {
				newTime = Math.max(0, existing.time_remaining - timeSinceLastSeen)
			}
			
			const updates = {
				username,
				status: 'online',
				last_seen: now,
				last_time_update: now,
				should_rejoin: false,
				time_remaining: newTime,
				error_msg: null,
				disconnected_at: null
			}
			
			await supabase
				.from('players')
				.update(updates)
				.eq('user_id', userId)
		}
		
		await cleanupPlayers()
		return res.status(200).json({ success: true, shouldRejoin: existing && existing.should_rejoin })
	}
	
	if (path === '/api/players' && req.method === 'GET') {
		const { data: players } = await supabase
			.from('players')
			.select('*')
			.order('first_seen', { ascending: false })
		
		const playersObj = {}
		if (players) {
			for (const p of players) {
				const timeSinceLastSeen = now - p.last_seen
				let currentStatus = p.status
				
				if (currentStatus === 'online' && timeSinceLastSeen > TIMEOUT_MS) {
					currentStatus = 'disconnected'
					await supabase
						.from('players')
						.update({
							status: 'disconnected',
							error_msg: 'Connection Timeout',
							disconnected_at: now
						})
						.eq('user_id', p.user_id)
				}
				
				let currentTime = p.time_remaining
				if (currentTime > 0 && currentStatus === 'online') {
					const elapsed = (now - p.last_time_update) / 1000
					currentTime = Math.max(0, currentTime - elapsed)
				}
				
				playersObj[p.user_id] = {
					username: p.username,
					userId: p.user_id,
					status: currentStatus,
					shouldRejoin: p.should_rejoin,
					timeRemaining: currentTime,
					selectedScript: p.selected_script,
					lastSeen: p.last_seen,
					lastTimeUpdate: p.last_time_update,
					firstSeen: p.first_seen,
					errorMsg: currentStatus === 'disconnected' && timeSinceLastSeen > TIMEOUT_MS ? 'Connection Timeout' : p.error_msg,
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
		
		const { error } = await supabase
			.from('players')
			.update({ should_rejoin: true })
			.eq('user_id', userId)
		
		if (error) return res.status(404).json({ error: 'Player not found' })
		
		return res.status(200).json({ success: true })
	}
	
	if (path === '/api/report' && req.method === 'POST') {
		const { username, userId, errorMsg } = body
		if (!username || !userId) return res.status(400).json({ error: 'Missing fields' })
		
		if (!errorMsg || !errorMsg.includes('joined a game from another device')) {
			return res.status(200).json({ success: true, ignored: true })
		}
		
		const { data: existing } = await supabase
			.from('players')
			.select('*')
			.eq('user_id', userId)
			.single()
		
		if (existing) {
			if (existing.error_msg !== 'Connection Timeout') {
				await supabase
					.from('players')
					.update({
						status: 'disconnected',
						error_msg: errorMsg,
						disconnected_at: now
					})
					.eq('user_id', userId)
			}
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
		if (!userId || timeToAdd === undefined) {
			return res.status(400).json({ error: 'Missing fields' })
		}
		
		const { data: player } = await supabase
			.from('players')
			.select('time_remaining')
			.eq('user_id', userId)
			.single()
		
		if (!player) return res.status(404).json({ error: 'Player not found' })
		
		const newTime = (player.time_remaining || 0) + timeToAdd
		
		await supabase
			.from('players')
			.update({
				time_remaining: newTime,
				last_time_update: now
			})
			.eq('user_id', userId)
		
		return res.status(200).json({ success: true, timeRemaining: newTime })
	}
	
	if (path === '/api/update-script' && req.method === 'POST') {
		const { userId, script } = body
		if (!userId || !script) {
			return res.status(400).json({ error: 'Missing fields' })
		}
		
		const { error } = await supabase
			.from('players')
			.update({ selected_script: script })
			.eq('user_id', userId)
		
		if (error) return res.status(404).json({ error: 'Player not found' })
		
		return res.status(200).json({ success: true })
	}
	
	if (path === '/api/script' && req.method === 'GET') {
		const luaScript = `local SERVER_URL = "${req.headers.host ? 'https://' + req.headers.host : 'https://cloudsync-rho.vercel.app'}"
local TeleportService = game:GetService("TeleportService")
local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local GuiService = game:GetService("GuiService")
local player = Players.LocalPlayer

local request = syn and syn.request or http and http.request or http_request or fluxus and fluxus.request or request

if not request then
	player:Kick("Your executor doesn't support HTTP requests")
	return
end

local running = true
local scriptLoaded = false
local teleporting = false

local function makeRequest(endpoint, method, data)
	local success, result = pcall(function()
		return request({
			Url = SERVER_URL .. endpoint,
			Method = method,
			Headers = {["Content-Type"] = "application/json"},
			Body = data and HttpService:JSONEncode(data) or nil
		})
	end)
	return success and result or nil
end

local function checkTimeAndScript()
	local response = makeRequest("/api/players", "GET")
	if response and response.Body then
		local success, data = pcall(function()
			return HttpService:JSONDecode(response.Body)
		end)
		if success and data.players then
			local myData = data.players[tostring(player.UserId)]
			if myData then
				return myData.timeRemaining, myData.selectedScript, myData.shouldRejoin
			end
		end
	end
	return nil, nil, false
end

local function sendHeartbeat()
	local response = makeRequest("/api/heartbeat", "POST", {
		username = player.Name,
		userId = tostring(player.UserId)
	})
	
	if response and response.Body then
		local success, data = pcall(function()
			return HttpService:JSONDecode(response.Body)
		end)
		if success and data.shouldRejoin then
			return true
		end
	end
	return false
end

local function reportDisconnect(reason)
	if not string.find(reason, "joined a game from another device") then
		return
	end
	
	makeRequest("/api/report", "POST", {
		username = player.Name,
		userId = tostring(player.UserId),
		errorMsg = reason
	})
	running = false
end

local function teleportToGame()
	if teleporting then return end
	teleporting = true
	
	print("Teleporting...")
	
	local success, err = pcall(function()
		TeleportService:Teleport(game.PlaceId, player)
	end)
	
	if not success then
		print("Teleport failed: " .. tostring(err))
		task.wait(2)
		teleporting = false
		teleportToGame()
	end
end

GuiService.ErrorMessageChanged:Connect(function(message)
	if typeof(message) == "string" then
		reportDisconnect(message)
	end
end)

sendHeartbeat()
task.wait(2)

local timeRemaining, selectedScript, shouldRejoin = checkTimeAndScript()

if shouldRejoin then
	print("Rejoin requested by admin. Teleporting...")
	task.wait(1)
	teleportToGame()
	return
end

if not timeRemaining or timeRemaining <= 0 then
	print("No time remaining. Rejoining in 2 seconds...")
	task.wait(2)
	teleportToGame()
	return
end

if not selectedScript or selectedScript == "none" then
	print("No script selected. Rejoining in 2 seconds...")
	task.wait(2)
	teleportToGame()
	return
end

print("Time remaining: " .. math.floor(timeRemaining / 60) .. " minutes")
print("Loading script: " .. selectedScript)

local scriptUrls = {
	atlas = "https://raw.githubusercontent.com/Chris12089/atlasbss/main/script.lua",
}

if scriptUrls[selectedScript] then
	local success = pcall(function()
		loadstring(game:HttpGet(scriptUrls[selectedScript]))()
	end)
	if success then
		scriptLoaded = true
		print("Script loaded successfully!")
	else
		print("Failed to load script. Rejoining in 2 seconds...")
		task.wait(2)
		teleportToGame()
		return
	end
else
	print("Invalid script selected. Rejoining in 2 seconds...")
	task.wait(2)
	teleportToGame()
	return
end

sendHeartbeat()

task.spawn(function()
	while running and not teleporting do
		task.wait(3)
		
		if teleporting then break end
		
		local shouldRejoinNow = sendHeartbeat()
		
		if shouldRejoinNow then
			print("Rejoin command received. Teleporting...")
			task.wait(1)
			teleportToGame()
			break
		end
		
		local currentTime, currentScript = checkTimeAndScript()
		
		if not currentTime or currentTime <= 0 then
			print("Time expired. Rejoining in 2 seconds...")
			task.wait(2)
			teleportToGame()
			break
		end
	end
end)`
		
		res.setHeader('Content-Type', 'text/plain')
		return res.status(200).send(luaScript)
	}
	
	return res.status(404).json({ error: 'Not found' })
}
