import { DurableObject } from 'cloudflare:workers'
import { connect } from 'cloudflare:sockets'

type TeamSide = 'A' | 'B'
type RoomCapacity = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12
type RoomStatus = 'waiting' | 'pick_decision' | 'drafting' | 'finished' | 'map_veto' | 'map_finished' | 'match_started' | 'closed'

const MAX_PLAYERS = 12
const ROOM_IDLE_MS = 2 * 60 * 60 * 1000
const MAP_POOL = [
  { id: 'dust2', name: 'Dust II' },
  { id: 'mirage', name: 'Mirage' },
  { id: 'inferno', name: 'Inferno' },
  { id: 'nuke', name: 'Nuke' },
  { id: 'ancient', name: 'Ancient' },
  { id: 'anubis', name: 'Anubis' },
  { id: 'cache', name: 'Cache' },
] as const
const MAP_VETO_ORDER: TeamSide[] = ['A', 'B', 'B', 'A', 'A', 'B']
const RANK_ENDPOINT = 'http://49.234.27.68:27000/rank.php'

interface Env {
  ROOMS: DurableObjectNamespace<DraftRoom>
  DIRECTORY: DurableObjectNamespace<RoomDirectory>
  STEAM_SESSION_SECRET?: string
  STEAM_API_KEY?: string
  RCON_HOST?: string
  RCON_PORT?: string
  RCON_PASSWORD?: string
  PUBLIC_ORIGIN?: string
}

interface StoredPlayer {
  id: string
  name: string
  steamId?: string
  avatarUrl?: string
  rankScore?: number | null
  rankTier?: string | null
  rankCheckedAt?: number
  tokenHash: string
  joinedAt: number
}

interface SteamSession {
  steamId: string
  steamName: string
  avatarUrl: string
  expiresAt: number
}

interface StoredRoom {
  code: string
  status: RoomStatus
  capacity: RoomCapacity
  hostPlayerId: string
  players: StoredPlayer[]
  captainAId: string | null
  captainBId: string | null
  captainsManual?: boolean
  teamAIds: string[]
  teamBIds: string[]
  draftOrder: TeamSide[]
  pickIndex: number
  createdAt: number
  updatedAt: number
  mapBannedIds: string[]
  mapTurn: TeamSide | null
  mapBanIndex: number
  selectedMapId: string | null
  rollA: number | null
  rollB: number | null
  rollWinner: TeamSide | null
  firstPickSide: TeamSide | null
  matchToken: string | null
  matchId: number | null
  matchStartedAt: number | null
}

interface DirectoryRoom {
  code: string
  playerCount: number
  maxPlayers: number
  status: RoomStatus
  updatedAt: number
}

interface WsAttachment {
  playerId: string
}

interface ClientAction {
  type: string
  captainAId?: string
  captainBId?: string
  playerId?: string
  mapId?: string
  firstPick?: boolean
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const STEAM_SESSION_COOKIE = 'cs2_steam_session'
const STEAM_LOGIN_STATE_COOKIE = 'cs2_steam_login_state'
const STEAM_SESSION_MAX_AGE = 7 * 24 * 60 * 60
const STEAM_LOGIN_STATE_MAX_AGE = 10 * 60
const RANK_REQUEST_INIT: RequestInit = {
  headers: {
    accept: 'text/html,application/xhtml+xml',
    'user-agent': 'Mozilla/5.0 (compatible; CS2-Draft-Room/1.0)',
  },
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS })
}

function redirect(location: string, headers?: Headers): Response {
  const responseHeaders = headers ?? new Headers()
  responseHeaders.set('location', location)
  return new Response(null, { status: 302, headers: responseHeaders })
}

function base64UrlEncode(value: string): string {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return base64UrlEncode(binary)
}

function base64UrlDecode(value: string): string {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  return atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4))
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') ?? ''
  for (const cookie of header.split(';')) {
    const [key, ...value] = cookie.trim().split('=')
    if (key === name) return value.join('=') || null
  }
  return null
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`
}

function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/'
  return value
}

function sessionSecret(env: Env): string {
  if (!env.STEAM_SESSION_SECRET) throw new Error('Steam 登录尚未配置会话密钥')
  return env.STEAM_SESSION_SECRET
}

async function hmac(value: string, secret: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
}

async function signedSessionCookie(session: SteamSession, env: Env): Promise<string> {
  const payload = base64UrlEncode(JSON.stringify(session))
  const signature = base64UrlEncodeBytes(new Uint8Array(await hmac(payload, sessionSecret(env))))
  return `${payload}.${signature}`
}

async function readSteamSession(request: Request, env: Env): Promise<SteamSession | null> {
  const raw = cookieValue(request, STEAM_SESSION_COOKIE)
  if (!raw) return null
  const [payload, signature] = raw.split('.')
  if (!payload || !signature) return null
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(sessionSecret(env)),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      Uint8Array.from(base64UrlDecode(signature), (character) => character.charCodeAt(0)),
      new TextEncoder().encode(payload),
    )
    if (!valid) return null
    const session = JSON.parse(base64UrlDecode(payload)) as SteamSession
    if (!/^\d{17}$/.test(session.steamId) || typeof session.steamName !== 'string' || !session.steamName || typeof session.avatarUrl !== 'string' || !session.avatarUrl || session.expiresAt <= Date.now()) return null
    return session
  } catch {
    return null
  }
}

async function steamLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const next = safeNextPath(url.searchParams.get('next'))
  const state = randomToken()
  const callback = new URL('/api/auth/steam/callback', url.origin)
  callback.searchParams.set('state', state)
  callback.searchParams.set('next', next)

  const steamUrl = new URL('https://steamcommunity.com/openid/login')
  steamUrl.searchParams.set('openid.ns', 'http://specs.openid.net/auth/2.0')
  steamUrl.searchParams.set('openid.mode', 'checkid_setup')
  steamUrl.searchParams.set('openid.return_to', callback.toString())
  steamUrl.searchParams.set('openid.realm', url.origin)
  steamUrl.searchParams.set('openid.identity', 'http://specs.openid.net/auth/2.0/identifier_select')
  steamUrl.searchParams.set('openid.claimed_id', 'http://specs.openid.net/auth/2.0/identifier_select')

  const headers = new Headers()
  headers.append('set-cookie', cookie(STEAM_LOGIN_STATE_COOKIE, state, STEAM_LOGIN_STATE_MAX_AGE))
  return redirect(steamUrl.toString(), headers)
}

async function steamCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const state = url.searchParams.get('state')
  const savedState = cookieValue(request, STEAM_LOGIN_STATE_COOKIE)
  if (!state || !savedState || state !== savedState) return json({ error: 'Steam 登录状态已失效，请重试' }, 400)

  const next = safeNextPath(url.searchParams.get('next'))
  const returnTo = url.searchParams.get('openid.return_to')
  const expectedReturnTo = new URL('/api/auth/steam/callback', url.origin)
  expectedReturnTo.searchParams.set('state', state)
  expectedReturnTo.searchParams.set('next', next)
  if (returnTo !== expectedReturnTo.toString()) return json({ error: 'Steam 登录回调地址校验失败' }, 400)
  if (url.searchParams.get('openid.mode') !== 'id_res') return json({ error: 'Steam 登录未完成' }, 400)
  if (url.searchParams.get('openid.op_endpoint') !== 'https://steamcommunity.com/openid/login') {
    return json({ error: 'Steam 登录来源校验失败' }, 400)
  }

  const verification = new URLSearchParams()
  for (const [key, value] of url.searchParams) {
    if (key.startsWith('openid.')) verification.set(key, value)
  }
  verification.set('openid.mode', 'check_authentication')
  const verificationResponse = await fetch('https://steamcommunity.com/openid/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: verification,
  })
  const verificationText = await verificationResponse.text()
  if (!verificationResponse.ok || !/^is_valid:true\s*$/m.test(verificationText)) {
    return json({ error: 'Steam 登录验证失败，请重试' }, 400)
  }

  const claimedId = url.searchParams.get('openid.claimed_id') ?? ''
  const steamId = claimedId.match(/^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/i)?.[1]
  if (!steamId) return json({ error: '无法读取 Steam ID' }, 400)

  let steamProfile: { steamName: string; avatarUrl: string }
  try {
    steamProfile = await fetchSteamProfile(steamId, env)
  } catch (error) {
    return json({ error: errorMessage(error) }, 503)
  }

  const session: SteamSession = {
    steamId,
    steamName: steamProfile.steamName,
    avatarUrl: steamProfile.avatarUrl,
    expiresAt: Date.now() + STEAM_SESSION_MAX_AGE * 1000,
  }
  const headers = new Headers()
  headers.append('set-cookie', cookie(STEAM_SESSION_COOKIE, await signedSessionCookie(session, env), STEAM_SESSION_MAX_AGE))
  headers.append('set-cookie', cookie(STEAM_LOGIN_STATE_COOKIE, '', 0))
  return redirect(new URL(next, url.origin).toString(), headers)
}

async function steamMe(request: Request, env: Env): Promise<Response> {
  try {
    const session = await readSteamSession(request, env)
    return json({
      authenticated: Boolean(session),
      steamId: session?.steamId ?? null,
      steamName: session?.steamName ?? null,
      avatarUrl: session?.avatarUrl ?? null,
    })
  } catch (error) {
    return json({ error: errorMessage(error) }, 503)
  }
}

async function fetchSteamProfile(steamId: string, env: Env): Promise<{ steamName: string; avatarUrl: string }> {
  if (!env.STEAM_API_KEY) throw new Error('Steam Web API Key 尚未配置')
  const apiUrl = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/')
  apiUrl.searchParams.set('key', env.STEAM_API_KEY)
  apiUrl.searchParams.set('steamids', steamId)
  const response = await fetch(apiUrl)
  if (!response.ok) throw new Error('Steam 昵称获取失败，请稍后重试')
  const data = await response.json().catch(() => null) as {
    response?: { players?: Array<{ personaname?: string; avatarfull?: string; avatarmedium?: string; avatar?: string }> }
  } | null
  const player = data?.response?.players?.[0]
  const steamName = player?.personaname?.trim()
  const avatarUrl = player?.avatarfull || player?.avatarmedium || player?.avatar
  if (!steamName || !avatarUrl) throw new Error('Steam 账号没有可用昵称或头像')
  return { steamName, avatarUrl }
}

interface RankEntry {
  steamId: string
  score: number
  tier: string | null
}

function parseRankEntries(html: string): RankEntry[] {
  const entries: RankEntry[] = []
  const pattern = /<div class="cell cell1"[^>]*data-steamid="(\d{17})"[\s\S]*?<div class="cell" data-title="段位"[^>]*>\s*([^<]*?)\s*<\/div>\s*<div class="cell" data-title="分数">\s*([\d,]+)\s*<\/div>/g
  for (const match of html.matchAll(pattern)) {
    const score = Number.parseInt(match[3].replaceAll(',', ''), 10)
    if (Number.isFinite(score)) entries.push({ steamId: match[1], score, tier: match[2].trim() || null })
  }
  return entries
}

function maxRankPage(html: string): number {
  let maxPage = 1
  const pattern = /[?&]page=(\d+)/g
  for (const match of html.matchAll(pattern)) maxPage = Math.max(maxPage, Number.parseInt(match[1], 10))
  return Math.min(maxPage, 25)
}

async function fetchRankEntry(steamId: string, steamName: string): Promise<RankEntry | null> {
  const searchUrl = new URL(RANK_ENDPOINT)
  searchUrl.searchParams.set('search', steamName)
  searchUrl.searchParams.set('server', 'Server')
  const searchResponse = await fetch(searchUrl, RANK_REQUEST_INIT)
  if (searchResponse.ok) {
    const searchEntries = parseRankEntries(await searchResponse.text())
    const match = searchEntries.find((entry) => entry.steamId === steamId)
    if (match) return match
  }

  const firstUrl = new URL(RANK_ENDPOINT)
  firstUrl.searchParams.set('server', 'Server')
  const firstResponse = await fetch(firstUrl, RANK_REQUEST_INIT)
  if (!firstResponse.ok) return null
  const firstHtml = await firstResponse.text()
  const firstEntries = parseRankEntries(firstHtml)
  const firstMatch = firstEntries.find((entry) => entry.steamId === steamId)
  if (firstMatch) return firstMatch

  const pages = Array.from({ length: Math.max(0, maxRankPage(firstHtml) - 1) }, (_, index) => index + 2)
  const pageEntries = await Promise.all(pages.map(async (page) => {
    const pageUrl = new URL(RANK_ENDPOINT)
    pageUrl.searchParams.set('server', 'Server')
    pageUrl.searchParams.set('page', String(page))
    const response = await fetch(pageUrl, RANK_REQUEST_INIT)
    return response.ok ? parseRankEntries(await response.text()) : []
  }))
  return pageEntries.flat().find((entry) => entry.steamId === steamId) ?? null
}

async function lookupRankEntry(steamId: string, steamName: string): Promise<RankEntry | null> {
  try {
    return await fetchRankEntry(steamId, steamName)
  } catch {
    return null
  }
}

interface RconPacket {
  id: number
  type: number
  body: string
}

class RconPacketReader {
  private buffer = new Uint8Array()

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async readPacket(): Promise<RconPacket> {
    const sizeBytes = await this.readExact(4)
    const size = new DataView(sizeBytes.buffer, sizeBytes.byteOffset, sizeBytes.byteLength).getInt32(0, true)
    if (size < 10 || size > 1_048_576) throw new Error('RCON 返回数据包无效')
    const payload = await this.readExact(size)
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    const id = view.getInt32(0, true)
    const type = view.getInt32(4, true)
    const body = new TextDecoder().decode(payload.slice(8, Math.max(8, payload.length - 2)))
    return { id, type, body }
  }

  release(): void {
    try { this.reader.releaseLock() } catch { /* Ignore release races. */ }
  }

  private async readExact(length: number): Promise<Uint8Array> {
    while (this.buffer.length < length) {
      const result = await this.reader.read()
      if (result.done || !result.value) throw new Error('RCON 连接已断开')
      const combined = new Uint8Array(this.buffer.length + result.value.length)
      combined.set(this.buffer)
      combined.set(result.value, this.buffer.length)
      this.buffer = combined
    }
    const output = this.buffer.slice(0, length)
    this.buffer = this.buffer.slice(length)
    return output
  }
}

function rconPacket(id: number, type: number, body: string): Uint8Array {
  const bodyBytes = new TextEncoder().encode(`${body}\0\0`)
  const payload = new Uint8Array(8 + bodyBytes.length)
  const view = new DataView(payload.buffer)
  view.setInt32(0, id, true)
  view.setInt32(4, type, true)
  payload.set(bodyBytes, 8)
  const packet = new Uint8Array(4 + payload.length)
  new DataView(packet.buffer).setInt32(0, payload.length, true)
  packet.set(payload, 4)
  return packet
}

async function readRconPacketWithTimeout(reader: RconPacketReader, timeoutMs = 5000): Promise<RconPacket> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.readPacket(),
      new Promise<RconPacket>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('RCON 连接超时')), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function rconExecute(command: string, env: Env): Promise<string> {
  const host = env.RCON_HOST ?? '2561417364.fuzzys'
  const port = Number(env.RCON_PORT ?? '27000')
  if (!env.RCON_PASSWORD || !host || !Number.isInteger(port)) throw new Error('RCON 尚未配置')

  const socket = connect({ hostname: host, port })
  const writer = socket.writable.getWriter()
  const packetReader = new RconPacketReader(socket.readable.getReader())
  try {
    await writer.write(rconPacket(1, 3, env.RCON_PASSWORD))
    let authenticated = false
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await readRconPacketWithTimeout(packetReader)
      if (response.id === -1) throw new Error('RCON 密码错误或服务器拒绝连接')
      if (response.id === 1) {
        authenticated = true
        break
      }
    }
    if (!authenticated) throw new Error('RCON 认证失败')

    await writer.write(rconPacket(2, 2, command))
    if (command === 'quit') return '服务器重启指令已发送'
    const response = await readRconPacketWithTimeout(packetReader)
    return response.body.trim() || '指令已发送'
  } finally {
    try { writer.releaseLock() } catch { /* Ignore release races. */ }
    packetReader.release()
    try { socket.close() } catch { /* Ignore close races. */ }
  }
}

function matchMapName(mapId: string): string {
  return mapId === 'dust2' ? 'de_dust2' : `de_${mapId}`
}

function matchConfigForRoom(room: StoredRoom) {
  const playerById = new Map(room.players.map((player) => [player.id, player]))
  const players = (ids: string[]) => Object.fromEntries(ids.map((id) => {
    const player = playerById.get(id)
    return [player?.steamId ?? '', player?.name ?? '']
  }).filter(([steamId]) => Boolean(steamId)))
  return {
    matchid: room.matchId,
    team1: { name: 'A', players: players(room.teamAIds) },
    team2: { name: 'B', players: players(room.teamBIds) },
    num_maps: 1,
    maplist: [matchMapName(room.selectedMapId ?? '')],
    map_sides: ['knife'],
    clinch_series: true,
    cvars: {
      hostname: `CS2 Draft ${room.code}`,
    },
  }
}

async function startLooseMatch(room: StoredRoom, env: Env): Promise<void> {
  const map = matchMapName(room.selectedMapId ?? '')
  await rconExecute('css_endmatch', env)
  await rconExecute(`map "${map}"`, env)
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  await rconExecute('css_start', env)
  await rconExecute('mp_autoteambalance 0; mp_limitteams 0; mp_spectators_max 20; mp_teamname_1 "A"; mp_teamname_2 "B"', env)
}

function matchLoadCommand(room: StoredRoom, env: Env): string {
  if (!room.matchToken) throw new Error('比赛配置令牌不存在')
  const origin = (env.PUBLIC_ORIGIN ?? 'https://pick.noyy.de').replace(/\/$/, '')
  const url = `${origin}/api/rooms/${room.code}/match.json`
  return `matchzy_loadmatch_url "${url}" "Authorization" "Bearer ${room.matchToken}"`
}

function steamLogout(): Response {
  const headers = new Headers()
  headers.append('set-cookie', cookie(STEAM_SESSION_COOKIE, '', 0))
  return json({ ok: true }, 200)
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
}

function normalizeText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new Error(`${field}格式不正确`)
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (normalized.length < min || normalized.length > max) {
    throw new Error(`${field}长度必须为 ${min}-${max} 个字符`)
  }
  return normalized
}

function randomRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return Array.from(bytes, (byte) => ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]).join('')
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function draftOrderFor(capacity: RoomCapacity, firstSide: TeamSide = 'A'): TeamSide[] {
  const otherSide = firstSide === 'A' ? 'B' : 'A'
  const pattern: TeamSide[] = [firstSide, otherSide, otherSide, firstSide]
  const remaining: Record<TeamSide, number> = {
    A: Math.ceil(capacity / 2) - 1,
    B: Math.floor(capacity / 2) - 1,
  }
  const order: TeamSide[] = []
  let patternIndex = 0

  while (order.length < capacity - 2) {
    const side = pattern[patternIndex % pattern.length]
    if (remaining[side] > 0) {
      order.push(side)
      remaining[side] -= 1
    }
    patternIndex += 1
  }

  return order
}

function teamTargetSize(side: TeamSide, capacity: RoomCapacity): number {
  return side === 'A' ? Math.ceil(capacity / 2) : Math.floor(capacity / 2)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '服务器发生未知错误'
}

function optionalRankScore(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.floor(value))
}

function optionalRankTier(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const tier = value.trim()
  return tier.length > 0 && tier.length <= 24 ? tier : null
}

function roomStub(env: Env, code: string): DurableObjectStub<DraftRoom> {
  return env.ROOMS.getByName(code)
}

function directoryStub(env: Env): DurableObjectStub<RoomDirectory> {
  return env.DIRECTORY.getByName('active-rooms')
}

async function forwardJson(stub: DurableObjectStub<DraftRoom>, path: string, body: unknown): Promise<Response> {
  return stub.fetch(new Request(`https://room.internal${path}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  }))
}

async function forwardDirectoryJson(env: Env, path: string, body: unknown): Promise<Response> {
  return directoryStub(env).fetch(new Request(`https://directory.internal${path}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  }))
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/auth/steam/login' && request.method === 'GET') {
      try {
        return await steamLogin(request, env)
      } catch (error) {
        return json({ error: errorMessage(error) }, 503)
      }
    }

    if (url.pathname === '/api/auth/steam/callback' && request.method === 'GET') {
      try {
        return await steamCallback(request, env)
      } catch (error) {
        return json({ error: errorMessage(error) }, 503)
      }
    }

    if (url.pathname === '/api/auth/steam/me' && request.method === 'GET') {
      return steamMe(request, env)
    }

    if (url.pathname === '/api/auth/steam/logout' && request.method === 'POST') {
      return steamLogout()
    }

    if (url.pathname === '/api/health') {
      return json({ ok: true, service: 'cs2-draft-room' })
    }

    if (url.pathname === '/api/rooms' && request.method === 'GET') {
      return directoryStub(env).fetch(new Request('https://directory.internal/list'))
    }

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const body = await request.json().catch(() => null) as Record<string, unknown> | null
      if (!body) return json({ error: '请求内容不是有效 JSON' }, 400)
      const session = await readSteamSession(request, env)
      if (!session) return json({ error: '请先使用 Steam 登录' }, 401)
      const rankEntry = await lookupRankEntry(session.steamId, session.steamName)

      for (let attempt = 0; attempt < 6; attempt += 1) {
        const code = randomRoomCode()
        const response = await forwardJson(roomStub(env, code), '/create', {
          ...body,
          code,
          steamId: session.steamId,
          steamName: session.steamName,
          avatarUrl: session.avatarUrl,
          rankScore: rankEntry?.score ?? null,
          rankTier: rankEntry?.tier ?? null,
        })
        if (response.status !== 409) return response
      }
      return json({ error: '暂时无法生成房间号，请重试' }, 503)
    }

    const joinMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{4,10})\/join$/)
    if (joinMatch && request.method === 'POST') {
      const code = normalizeCode(joinMatch[1])
      const body = await request.json().catch(() => null)
      const session = await readSteamSession(request, env)
      if (!session) return json({ error: '请先使用 Steam 登录' }, 401)
      const rankEntry = await lookupRankEntry(session.steamId, session.steamName)
      return forwardJson(roomStub(env, code), '/join', {
        ...(body && typeof body === 'object' ? body : {}),
        steamId: session.steamId,
        steamName: session.steamName,
        avatarUrl: session.avatarUrl,
        rankScore: rankEntry?.score ?? null,
        rankTier: rankEntry?.tier ?? null,
      })
    }

    const matchConfigMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{4,10})\/match\.json$/)
    if (matchConfigMatch && request.method === 'GET') {
      const code = normalizeCode(matchConfigMatch[1])
      const headers = new Headers()
      const authorization = request.headers.get('authorization')
      if (authorization) headers.set('authorization', authorization)
      return roomStub(env, code).fetch(new Request('https://room.internal/match.json', { headers }))
    }

    const stateMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{4,10})\/state$/)
    if (stateMatch && request.method === 'GET') {
      const code = normalizeCode(stateMatch[1])
      return roomStub(env, code).fetch(new Request('https://room.internal/state'))
    }

    const socketMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{4,10})\/ws$/)
    if (socketMatch && request.method === 'GET') {
      const code = normalizeCode(socketMatch[1])
      return roomStub(env, code).fetch(request)
    }

    return json({ error: 'API 路径不存在' }, 404)
  },
} satisfies ExportedHandler<Env>

export class DraftRoom extends DurableObject<Env> {
  private room: StoredRoom | null = null
  private actionChain: Promise<void> = Promise.resolve()
  private profileRefresh: Promise<void> | null = null
  private readonly roomEnv: Env

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.roomEnv = env
    this.ctx.blockConcurrencyWhile(async () => {
      this.room = (await this.ctx.storage.get<StoredRoom>('room')) ?? null
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/create' && request.method === 'POST') return this.createRoom(request)
    if (url.pathname === '/join' && request.method === 'POST') return this.joinRoom(request)
    if (url.pathname === '/match.json' && request.method === 'GET') return this.matchConfig(request)
    if (url.pathname === '/state' && request.method === 'GET') {
      if (!this.room) return json({ error: '房间不存在' }, 404)
      await this.refreshMissingPlayerData()
      return json({ state: this.publicState() })
    }
    if (url.pathname.endsWith('/ws') && request.method === 'GET') return this.openSocket(request)

    return json({ error: '房间接口不存在' }, 404)
  }

  async alarm(): Promise<void> {
    if (!this.room) return
    const expiresAt = this.room.updatedAt + ROOM_IDLE_MS
    if (Date.now() < expiresAt) {
      await this.ctx.storage.setAlarm(expiresAt)
      return
    }

    await forwardDirectoryJson(this.roomEnv, '/unregister', { code: this.room.code })
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(4404, 'room expired') } catch { /* Ignore close races. */ }
    }
    this.room = null
    await this.ctx.storage.deleteAll()
  }

  private async createRoom(request: Request): Promise<Response> {
    if (this.room) return json({ error: '房间号冲突' }, 409)
    try {
      const body = await request.json() as Record<string, unknown>
      const code = normalizeCode(String(body.code ?? ''))
      const name = normalizeText(body.steamName, 'Steam 昵称', 1, 64)
      const steamId = normalizeText(body.steamId, 'Steam ID', 17, 17)
      const avatarUrl = normalizeText(body.avatarUrl, 'Steam 头像', 8, 500)
      const rankScore = optionalRankScore(body.rankScore)
      const rankTier = optionalRankTier(body.rankTier)
      const token = randomToken()
      const playerId = crypto.randomUUID()
      const now = Date.now()
      this.room = {
        code,
        status: 'waiting',
        capacity: MAX_PLAYERS,
        hostPlayerId: playerId,
        players: [{ id: playerId, name, steamId, avatarUrl, rankScore, rankTier, rankCheckedAt: now, tokenHash: await hashToken(token), joinedAt: now }],
        captainAId: null,
        captainBId: null,
        captainsManual: false,
        teamAIds: [],
        teamBIds: [],
        draftOrder: [],
        pickIndex: 0,
        createdAt: now,
        updatedAt: now,
        mapBannedIds: [],
        mapTurn: null,
        mapBanIndex: 0,
        selectedMapId: null,
        rollA: null,
        rollB: null,
        rollWinner: null,
        firstPickSide: null,
        matchToken: null,
        matchId: null,
        matchStartedAt: null,
      }
      await this.persist()
      return json({ roomCode: code, playerId, token, state: this.publicState() }, 201)
    } catch (error) {
      return json({ error: errorMessage(error) }, 400)
    }
  }

  private async joinRoom(request: Request): Promise<Response> {
    if (!this.room) return json({ error: '房间不存在' }, 404)
    try {
      if (this.room.status !== 'waiting') throw new Error('选人已经开始，不能再加入')
      if (this.room.players.length >= this.room.capacity) throw new Error('房间已经满员')
      const body = await request.json() as Record<string, unknown>
      const name = normalizeText(body.steamName, 'Steam 昵称', 1, 64)
      const steamId = normalizeText(body.steamId, 'Steam ID', 17, 17)
      const avatarUrl = normalizeText(body.avatarUrl, 'Steam 头像', 8, 500)
      const rankScore = optionalRankScore(body.rankScore)
      const rankTier = optionalRankTier(body.rankTier)
      const nameKey = name.toLocaleLowerCase()
      if (this.room.players.some((player) => player.steamId === steamId)) {
        throw new Error('这个 Steam 账号已经在房间中')
      }
      if (this.room.players.some((player) => player.name.toLocaleLowerCase() === nameKey)) {
        throw new Error('这个游戏昵称已经有人使用')
      }

      const token = randomToken()
      const playerId = crypto.randomUUID()
      this.room.players.push({
        id: playerId,
        name,
        steamId,
        avatarUrl,
        rankScore,
        rankTier,
        rankCheckedAt: Date.now(),
        tokenHash: await hashToken(token),
        joinedAt: Date.now(),
      })
      this.updateAutomaticCaptains()
      this.room.updatedAt = Date.now()
      await this.persist()
      this.broadcastState()
      return json({ playerId, token, state: this.publicState() }, 201)
    } catch (error) {
      return json({ error: errorMessage(error) }, 400)
    }
  }

  private async matchConfig(request: Request): Promise<Response> {
    if (!this.room || !this.room.matchToken) return json({ error: '比赛配置不存在' }, 404)
    const authorization = request.headers.get('authorization')
    if (authorization !== `Bearer ${this.room.matchToken}`) return json({ error: '比赛配置授权失败' }, 401)
    return json(matchConfigForRoom(this.room))
  }

  private async openSocket(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: '需要 WebSocket Upgrade' }, 426)
    }
    if (!this.room) return this.closedSocketResponse(4404, 'room not found')
    await this.refreshMissingPlayerData()

    const token = new URL(request.url).searchParams.get('token') ?? ''
    const tokenHash = await hashToken(token)
    const player = this.room.players.find((candidate) => candidate.tokenHash === tokenHash)
    if (!player) return this.closedSocketResponse(4401, 'invalid session')

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ playerId: player.id } satisfies WsAttachment)
    server.send(JSON.stringify({ type: 'state', state: this.publicState() }))
    queueMicrotask(() => this.broadcastState())

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket })
  }


  private closedSocketResponse(code: number, reason: string): Response {
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ playerId: '' } satisfies WsAttachment)
    server.close(code, reason)
    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket })
  }

  async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message !== 'string') {
      this.sendError(socket, '只支持文本消息')
      return
    }

    let action: ClientAction
    try {
      action = JSON.parse(message) as ClientAction
    } catch {
      this.sendError(socket, '消息不是有效 JSON')
      return
    }

    const attachment = socket.deserializeAttachment() as WsAttachment | null
    if (!attachment?.playerId) {
      socket.close(4401, 'invalid session')
      return
    }

    this.actionChain = this.actionChain
      .then(() => this.handleAction(socket, attachment.playerId, action))
      .catch((error) => this.sendError(socket, errorMessage(error)))
    await this.actionChain
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    socket.close(code, reason)
    this.broadcastState()
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    try { socket.close(1011, 'socket error') } catch { /* Socket may already be closed. */ }
    this.broadcastState()
  }

  private async handleAction(socket: WebSocket, actorId: string, action: ClientAction): Promise<void> {
    const room = this.room
    if (!room) throw new Error('房间不存在')
    const actor = room.players.find((player) => player.id === actorId)
    if (!actor) {
      socket.close(4401, 'player removed')
      return
    }

    let noticeMessage: string | null = null

    switch (action.type) {
      case 'set_captains': {
        this.requireHost(actorId)
        this.requireWaitingAndReadyForCaptains()
        const captainAId = String(action.captainAId ?? '')
        const captainBId = String(action.captainBId ?? '')
        if (captainAId === captainBId) throw new Error('两位队长不能是同一个人')
        if (!this.hasPlayer(captainAId) || !this.hasPlayer(captainBId)) throw new Error('选择的队长不在房间中')
        room.captainAId = captainAId
        room.captainBId = captainBId
        room.captainsManual = true
        room.teamAIds = [captainAId]
        room.teamBIds = [captainBId]
        break
      }
      case 'random_captains': {
        this.requireHost(actorId)
        this.requireWaitingAndReadyForCaptains()
        const shuffled = [...room.players]
        for (let index = shuffled.length - 1; index > 0; index -= 1) {
          const target = crypto.getRandomValues(new Uint32Array(1))[0] % (index + 1)
          ;[shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]]
        }
        room.captainAId = shuffled[0].id
        room.captainBId = shuffled[1].id
        room.captainsManual = true
        room.teamAIds = [shuffled[0].id]
        room.teamBIds = [shuffled[1].id]
        break
      }
      case 'start_draft': {
        this.requireHost(actorId)
        this.requireWaitingAndReadyToStart()
        if (!room.captainAId || !room.captainBId) throw new Error('请先设置两名队长')
        room.capacity = room.players.length as RoomCapacity
        room.teamAIds = [room.captainAId]
        room.teamBIds = [room.captainBId]
        room.draftOrder = []
        room.pickIndex = 0
        room.firstPickSide = null
        room.captainsManual = false
        room.rollA = crypto.getRandomValues(new Uint32Array(1))[0] % 101
        do {
          room.rollB = crypto.getRandomValues(new Uint32Array(1))[0] % 101
        } while (room.rollB === room.rollA)
        room.rollWinner = room.rollA > room.rollB ? 'A' : 'B'
        room.status = 'pick_decision'
        break
      }
      case 'choose_pick_order': {
        if (room.status !== 'pick_decision') throw new Error('当前不是先后手决定阶段')
        if (!room.rollWinner) throw new Error('点数结果不存在')
        const winnerCaptainId = room.rollWinner === 'A' ? room.captainAId : room.captainBId
        if (actorId !== winnerCaptainId) throw new Error('只有点数较高的队长可以决定先后手')
        const firstSide = action.firstPick === true ? room.rollWinner : room.rollWinner === 'A' ? 'B' : 'A'
        room.firstPickSide = firstSide
        room.draftOrder = draftOrderFor(room.capacity, firstSide)
        room.pickIndex = 0
        room.status = room.draftOrder.length === 0 ? 'finished' : 'drafting'
        break
      }
      case 'pick_player': {
        if (room.status !== 'drafting') throw new Error('当前不在选人阶段')
        const currentSide = room.draftOrder[room.pickIndex]
        const expectedCaptainId = currentSide === 'A' ? room.captainAId : room.captainBId
        if (actorId !== expectedCaptainId) throw new Error('还没有轮到你选人')
        const selectedId = String(action.playerId ?? '')
        if (!this.hasPlayer(selectedId)) throw new Error('该玩家不在房间中')
        if (room.teamAIds.includes(selectedId) || room.teamBIds.includes(selectedId)) {
          throw new Error('该玩家已经被选择')
        }
        const targetTeam = currentSide === 'A' ? room.teamAIds : room.teamBIds
        if (targetTeam.length >= teamTargetSize(currentSide, room.capacity)) throw new Error('队伍已经满员')
        targetTeam.push(selectedId)
        room.pickIndex += 1
        if (room.pickIndex >= room.draftOrder.length) room.status = 'finished'
        break
      }
      case 'start_map_veto': {
        this.requireHost(actorId)
        if (room.status !== 'finished') throw new Error('请先完成选人')
        room.mapBannedIds = []
        room.mapTurn = MAP_VETO_ORDER[0]
        room.mapBanIndex = 0
        room.selectedMapId = null
        room.status = 'map_veto'
        break
      }
      case 'ban_map': {
        if (room.status !== 'map_veto') throw new Error('当前不是地图禁选阶段')
        const currentSide = room.mapTurn
        const expectedCaptainId = currentSide === 'A' ? room.captainAId : currentSide === 'B' ? room.captainBId : null
        if (!currentSide || actorId !== expectedCaptainId) throw new Error('还没有轮到你禁图')
        const mapId = String(action.mapId ?? '')
        if (!MAP_POOL.some((map) => map.id === mapId)) throw new Error('地图不在当前服役地图池')
        if (room.mapBannedIds.includes(mapId)) throw new Error('这张地图已经被禁用')
        room.mapBannedIds.push(mapId)
        room.mapBanIndex += 1
        if (room.mapBanIndex >= MAP_VETO_ORDER.length) {
          room.selectedMapId = MAP_POOL.find((map) => !room.mapBannedIds.includes(map.id))?.id ?? null
          room.mapTurn = null
          room.status = 'map_finished'
        } else {
          room.mapTurn = MAP_VETO_ORDER[room.mapBanIndex]
        }
        break
      }
      case 'kick_player': {
        this.requireHost(actorId)
        if (room.status !== 'waiting') throw new Error('选人开始后不能移出玩家')
        const targetId = String(action.playerId ?? '')
        if (targetId === room.hostPlayerId) throw new Error('不能移出房主')
        const before = room.players.length
        room.players = room.players.filter((player) => player.id !== targetId)
        if (room.players.length === before) throw new Error('没有找到该玩家')
        if (room.captainAId === targetId) room.captainAId = null
        if (room.captainBId === targetId) room.captainBId = null
        room.teamAIds = room.captainAId ? [room.captainAId] : []
        room.teamBIds = room.captainBId ? [room.captainBId] : []
        this.updateAutomaticCaptains()
        this.closePlayerSockets(targetId, 4401, 'removed by host')
        break
      }
      case 'reset_room': {
        this.requireHost(actorId)
        room.capacity = MAX_PLAYERS
        room.status = 'waiting'
        room.captainAId = null
        room.captainBId = null
        room.captainsManual = false
        room.teamAIds = []
        room.teamBIds = []
        room.draftOrder = []
        room.pickIndex = 0
        room.mapBannedIds = []
        room.mapTurn = null
        room.mapBanIndex = 0
        room.selectedMapId = null
        room.rollA = null
        room.rollB = null
        room.rollWinner = null
        room.firstPickSide = null
        room.matchToken = null
        room.matchId = null
        room.matchStartedAt = null
        this.updateAutomaticCaptains()
        break
      }
      case 'close_room': {
        this.requireHost(actorId)
        room.status = 'closed'
        break
      }
      case 'start_match': {
        this.requireHost(actorId)
        if (room.status !== 'map_finished' || !room.selectedMapId) throw new Error('请先完成 BO1 地图禁选')
        const selectedPlayers = [...room.teamAIds, ...room.teamBIds]
          .map((playerId) => room.players.find((player) => player.id === playerId))
        if (selectedPlayers.some((player) => !player?.steamId)) throw new Error('有玩家缺少 Steam64 ID，无法加载 MatchZy 比赛')
        room.matchId = null
        room.matchToken = null
        room.matchStartedAt = null
        await this.persist()
        try {
          await startLooseMatch(room, this.roomEnv)
          room.status = 'match_started'
          room.matchStartedAt = Date.now()
          noticeMessage = '自由娱乐模式已启动，玩家可以自由换队或观战'
        } catch (error) {
          room.matchToken = null
          room.matchId = null
          await this.persist()
          throw error
        }
        break
      }
      default:
        throw new Error('不支持的操作')
    }

    room.updatedAt = Date.now()
    await this.persist()
    this.broadcastState()
    if (noticeMessage) this.broadcastNotice(noticeMessage)

    if (room.status === 'closed') {
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.close(4404, 'room closed') } catch { /* Ignore close races. */ }
      }
    }
  }

  private requireHost(actorId: string): void {
    if (!this.room || actorId !== this.room.hostPlayerId) throw new Error('只有房主可以执行此操作')
  }

  private async refreshMissingPlayerData(): Promise<void> {
    if (!this.room || this.room.status !== 'waiting') return
    if (this.profileRefresh) return this.profileRefresh

    const refresh = async () => {
      const now = Date.now()
      const playersToRefresh = this.room?.players.filter((player) => {
        if (!player.steamId) return false
        const rankMissing = player.rankScore == null || player.rankTier == null
        return !player.avatarUrl || !player.rankCheckedAt || now - player.rankCheckedAt >= 60_000 || (rankMissing && now - player.rankCheckedAt >= 10_000)
      }) ?? []
      if (playersToRefresh.length === 0) return

      for (const player of playersToRefresh) {
        if (!player.avatarUrl) {
          try { player.avatarUrl = (await fetchSteamProfile(player.steamId!, this.roomEnv)).avatarUrl } catch { /* Keep the current profile data. */ }
        }
        const rankEntry = await lookupRankEntry(player.steamId!, player.name)
        player.rankScore = rankEntry?.score ?? null
        player.rankTier = rankEntry?.tier ?? null
        player.rankCheckedAt = now
      }
      this.updateAutomaticCaptains()
      await this.persist()
    }

    this.profileRefresh = refresh().finally(() => { this.profileRefresh = null })
    await this.profileRefresh
  }

  private updateAutomaticCaptains(): void {
    if (!this.room || this.room.captainsManual || this.room.status !== 'waiting') return
    const rankedPlayers = this.room.players
      .filter((player) => typeof player.rankScore === 'number')
      .sort((left, right) => (right.rankScore ?? -1) - (left.rankScore ?? -1) || left.joinedAt - right.joinedAt)
    const captainA = rankedPlayers[0]
    const captainB = rankedPlayers[1]
    this.room.captainAId = captainA?.id ?? null
    this.room.captainBId = captainB?.id ?? null
    this.room.teamAIds = captainA ? [captainA.id] : []
    this.room.teamBIds = captainB ? [captainB.id] : []
  }

  private requireWaiting(): void {
    if (!this.room) throw new Error('房间不存在')
    if (this.room.status !== 'waiting') throw new Error('当前不是等待阶段')
  }

  private requireWaitingAndReadyForCaptains(): void {
    this.requireWaiting()
    if (!this.room || this.room.players.length < 2) throw new Error('至少需要 2 名玩家')
  }

  private requireWaitingAndReadyToStart(): void {
    this.requireWaiting()
  }

  private hasPlayer(playerId: string): boolean {
    return Boolean(this.room?.players.some((player) => player.id === playerId))
  }

  private closePlayerSockets(playerId: string, code: number, reason: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as WsAttachment | null
      if (attachment?.playerId === playerId) {
        try { socket.close(code, reason) } catch { /* Ignore close races. */ }
      }
    }
  }

  private publicState() {
    const room = this.room
    if (!room) return null
    const onlineIds = new Set<string>()
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as WsAttachment | null
      if (attachment?.playerId) onlineIds.add(attachment.playerId)
    }
    const selected = new Set([...room.teamAIds, ...room.teamBIds])
    const availablePlayerIds = room.players.filter((player) => !selected.has(player.id)).map((player) => player.id)
    return {
      code: room.code,
      status: room.status,
      capacity: room.capacity,
      teamSize: Math.ceil(room.capacity / 2),
      hostPlayerId: room.hostPlayerId,
      captainAId: room.captainAId,
      captainBId: room.captainBId,
      teamAIds: room.teamAIds,
      teamBIds: room.teamBIds,
      availablePlayerIds,
      currentTurn: room.status === 'drafting' ? room.draftOrder[room.pickIndex] ?? null : null,
      pickIndex: room.pickIndex,
      totalPicks: room.draftOrder.length,
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        steamId: player.steamId ?? null,
        avatarUrl: player.avatarUrl ?? null,
        rankScore: player.rankScore ?? null,
        rankTier: player.rankTier ?? null,
        joinedAt: player.joinedAt,
        online: onlineIds.has(player.id),
        isHost: player.id === room.hostPlayerId,
        isCaptainA: player.id === room.captainAId,
        isCaptainB: player.id === room.captainBId,
        team: room.teamAIds.includes(player.id) ? 'A' : room.teamBIds.includes(player.id) ? 'B' : null,
      })),
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      maps: MAP_POOL,
      bannedMapIds: room.mapBannedIds ?? [],
      mapTurn: room.mapTurn ?? null,
      mapBanIndex: room.mapBanIndex ?? 0,
      mapTotalBans: MAP_VETO_ORDER.length,
      selectedMapId: room.selectedMapId ?? null,
      rollA: room.rollA ?? null,
      rollB: room.rollB ?? null,
      rollWinner: room.rollWinner ?? null,
      firstPickSide: room.firstPickSide ?? null,
      matchStartedAt: room.matchStartedAt ?? null,
    }
  }

  private async persist(): Promise<void> {
    if (!this.room) return
    await this.ctx.storage.put('room', this.room)
    if (this.room.status === 'closed') {
      await forwardDirectoryJson(this.roomEnv, '/unregister', { code: this.room.code })
      return
    }
    await this.ctx.storage.setAlarm(this.room.updatedAt + ROOM_IDLE_MS)
    await this.syncDirectory()
  }

  private async syncDirectory(): Promise<void> {
    if (!this.room) return
    await forwardDirectoryJson(this.roomEnv, '/sync', {
      code: this.room.code,
      playerCount: this.room.players.length,
      maxPlayers: MAX_PLAYERS,
      status: this.room.status,
      updatedAt: this.room.updatedAt,
    } satisfies DirectoryRoom)
  }

  private broadcastState(): void {
    const message = JSON.stringify({ type: 'state', state: this.publicState() })
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(message) } catch { /* A later close event will clean it up. */ }
    }
  }

  private sendError(socket: WebSocket, message: string): void {
    try { socket.send(JSON.stringify({ type: 'error', message })) } catch { /* Ignore closed sockets. */ }
  }

  private broadcastNotice(message: string): void {
    const payload = JSON.stringify({ type: 'notice', message })
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(payload) } catch { /* Ignore closed sockets. */ }
    }
  }
}

export class RoomDirectory extends DurableObject<Env> {
  private rooms: DirectoryRoom[] = []

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.blockConcurrencyWhile(async () => {
      this.rooms = (await this.ctx.storage.get<DirectoryRoom[]>('rooms')) ?? []
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/list' && request.method === 'GET') {
      const now = Date.now()
      const activeRooms = this.rooms.filter((room) => now - room.updatedAt < ROOM_IDLE_MS && room.status !== 'closed')
      if (activeRooms.length !== this.rooms.length) {
        this.rooms = activeRooms
        await this.persist()
      }
      return json({ rooms: activeRooms.filter((room) => room.status === 'waiting' && room.playerCount < room.maxPlayers) })
    }

    if (url.pathname === '/sync' && request.method === 'POST') {
      const room = await request.json().catch(() => null) as DirectoryRoom | null
      if (!room?.code) return json({ error: '房间目录数据无效' }, 400)
      this.rooms = [...this.rooms.filter((entry) => entry.code !== room.code), room]
      await this.persist()
      return json({ ok: true })
    }

    if (url.pathname === '/unregister' && request.method === 'POST') {
      const body = await request.json().catch(() => null) as { code?: string } | null
      if (body?.code) {
        this.rooms = this.rooms.filter((room) => room.code !== body.code)
        await this.persist()
      }
      return json({ ok: true })
    }

    return json({ error: '目录接口不存在' }, 404)
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put('rooms', this.rooms)
  }
}
