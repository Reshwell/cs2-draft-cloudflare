import { DurableObject } from 'cloudflare:workers'

type TeamSide = 'A' | 'B'
type RoomCapacity = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12
type RoomStatus = 'waiting' | 'pick_decision' | 'drafting' | 'finished' | 'map_veto' | 'map_finished' | 'closed'

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

interface Env {
  ROOMS: DurableObjectNamespace<DraftRoom>
  DIRECTORY: DurableObjectNamespace<RoomDirectory>
}

interface StoredPlayer {
  id: string
  name: string
  tokenHash: string
  joinedAt: number
}

interface StoredRoom {
  code: string
  status: RoomStatus
  capacity: RoomCapacity
  hostPlayerId: string
  players: StoredPlayer[]
  captainAId: string | null
  captainBId: string | null
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS })
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

    if (url.pathname === '/api/health') {
      return json({ ok: true, service: 'cs2-draft-room' })
    }

    if (url.pathname === '/api/rooms' && request.method === 'GET') {
      return directoryStub(env).fetch(new Request('https://directory.internal/list'))
    }

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const body = await request.json().catch(() => null) as Record<string, unknown> | null
      if (!body) return json({ error: '请求内容不是有效 JSON' }, 400)

      for (let attempt = 0; attempt < 6; attempt += 1) {
        const code = randomRoomCode()
        const response = await forwardJson(roomStub(env, code), '/create', { ...body, code })
        if (response.status !== 409) return response
      }
      return json({ error: '暂时无法生成房间号，请重试' }, 503)
    }

    const joinMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{4,10})\/join$/)
    if (joinMatch && request.method === 'POST') {
      const code = normalizeCode(joinMatch[1])
      const body = await request.json().catch(() => null)
      return forwardJson(roomStub(env, code), '/join', body)
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
    if (url.pathname === '/state' && request.method === 'GET') {
      if (!this.room) return json({ error: '房间不存在' }, 404)
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
      const name = normalizeText(body.name, '游戏昵称', 2, 24)
      const token = randomToken()
      const playerId = crypto.randomUUID()
      const now = Date.now()
      this.room = {
        code,
        status: 'waiting',
        capacity: MAX_PLAYERS,
        hostPlayerId: playerId,
        players: [{ id: playerId, name, tokenHash: await hashToken(token), joinedAt: now }],
        captainAId: null,
        captainBId: null,
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
      const name = normalizeText(body.name, '游戏昵称', 2, 24)
      const nameKey = name.toLocaleLowerCase()
      if (this.room.players.some((player) => player.name.toLocaleLowerCase() === nameKey)) {
        throw new Error('这个游戏昵称已经有人使用')
      }

      const token = randomToken()
      const playerId = crypto.randomUUID()
      this.room.players.push({
        id: playerId,
        name,
        tokenHash: await hashToken(token),
        joinedAt: Date.now(),
      })
      this.room.updatedAt = Date.now()
      await this.persist()
      this.broadcastState()
      return json({ playerId, token, state: this.publicState() }, 201)
    } catch (error) {
      return json({ error: errorMessage(error) }, 400)
    }
  }

  private async openSocket(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: '需要 WebSocket Upgrade' }, 426)
    }
    if (!this.room) return this.closedSocketResponse(4404, 'room not found')

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
        this.closePlayerSockets(targetId, 4401, 'removed by host')
        break
      }
      case 'reset_room': {
        this.requireHost(actorId)
        room.capacity = MAX_PLAYERS
        room.status = 'waiting'
        room.captainAId = null
        room.captainBId = null
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
        break
      }
      case 'close_room': {
        this.requireHost(actorId)
        room.status = 'closed'
        break
      }
      default:
        throw new Error('不支持的操作')
    }

    room.updatedAt = Date.now()
    await this.persist()
    this.broadcastState()

    if (room.status === 'closed') {
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.close(4404, 'room closed') } catch { /* Ignore close races. */ }
      }
    }
  }

  private requireHost(actorId: string): void {
    if (!this.room || actorId !== this.room.hostPlayerId) throw new Error('只有房主可以执行此操作')
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
