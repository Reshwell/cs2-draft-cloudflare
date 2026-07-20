import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ClientAction,
  PublicPlayer,
  PublicRoomState,
  ServerMessage,
  SessionCredentials,
  SteamUser,
  TeamSide,
} from './types'

const SESSION_PREFIX = 'cs2-draft-session:'

function normalizeCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
}

function currentRoomCode(): string | null {
  const match = window.location.pathname.match(/^\/room\/([A-Za-z0-9]{4,10})\/?$/)
  return match ? normalizeCode(match[1]) : null
}

function navigate(path: string) {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function saveSession(session: SessionCredentials) {
  localStorage.setItem(`${SESSION_PREFIX}${session.roomCode}`, JSON.stringify(session))
}

function loadSession(roomCode: string): SessionCredentials | null {
  const raw = localStorage.getItem(`${SESSION_PREFIX}${roomCode}`)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as SessionCredentials
    if (parsed.roomCode === roomCode && parsed.playerId && parsed.token) return parsed
  } catch {
    // Ignore malformed local storage.
  }
  return null
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const payload = (await response.json().catch(() => null)) as { error?: string } | null
  if (!response.ok) throw new Error(payload?.error || `请求失败（${response.status}）`)
  return payload as T
}

function useRoute() {
  const [roomCode, setRoomCode] = useState<string | null>(() => currentRoomCode())
  useEffect(() => {
    const onPopState = () => setRoomCode(currentRoomCode())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])
  return roomCode
}

export default function App() {
  const roomCode = useRoute()
  const steam = useSteamAuth()
  return roomCode ? <RoomPage roomCode={roomCode} steam={steam} /> : <HomePage steam={steam} />
}

interface SteamAuthState {
  user: SteamUser | null
  loading: boolean
  refresh: () => Promise<void>
  logout: () => Promise<void>
}

function useSteamAuth(): SteamAuthState {
  const [user, setUser] = useState<SteamUser | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = async () => {
    try {
      const result = await apiJson<{ authenticated: boolean; steamId: string | null; steamName: string | null; avatarUrl: string | null }>('/api/auth/steam/me')
      setUser(result.authenticated && result.steamId && result.steamName && result.avatarUrl
        ? { steamId: result.steamId, steamName: result.steamName, avatarUrl: result.avatarUrl }
        : null)
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const logout = async () => {
    await apiJson<{ ok: boolean }>('/api/auth/steam/logout', { method: 'POST' }).catch(() => undefined)
    setUser(null)
  }

  return { user, loading, refresh, logout }
}

function steamLogin(next = window.location.pathname) {
  window.location.assign(`/api/auth/steam/login?next=${encodeURIComponent(next || '/')}`)
}

function SteamAccount({ steam, compact = false }: { steam: SteamAuthState; compact?: boolean }) {
  if (steam.loading) return <span className="steam-account muted">检查 Steam 登录…</span>
  if (!steam.user) {
    return <button className={`steam-login-button ${compact ? 'compact' : ''}`} onClick={() => steamLogin()} type="button">使用 Steam 登录</button>
  }
  return (
    <div className={`steam-account ${compact ? 'compact' : ''}`}>
      <img className="steam-avatar" src={steam.user.avatarUrl} alt="" />
      <span className="steam-account-name">{steam.user.steamName}</span>
      <button className="text-button" onClick={() => void steam.logout()} type="button">退出</button>
    </div>
  )
}

function BrandMark() {
  return (
    <button className="brand-mark" onClick={() => navigate('/')} type="button" aria-label="返回首页">
      <span className="brand-mark-icon">+</span>
      <span>选人房</span>
    </button>
  )
}

function Topbar({ steam, roomCode }: { steam: SteamAuthState; roomCode?: string }) {
  return (
    <header className="topbar">
      <BrandMark />
      <nav className="topnav" aria-label="主导航">
        <button className="topnav-item active" onClick={() => navigate('/')} type="button"><span>◈</span> 大厅</button>
        {roomCode && <span className="topnav-room">房间 / {roomCode}</span>}
      </nav>
      <div className="topbar-account"><SteamAccount steam={steam} compact /></div>
    </header>
  )
}

function SourceCodeLink() {
  return (
    <footer className="source-footer">
      <a href="https://github.com/Reshwell/cs2-draft-cloudflare" target="_blank" rel="noreferrer">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 .7a11.3 11.3 0 0 0-3.57 22.02c.56.1.77-.24.77-.54v-2.1c-3.14.68-3.8-1.34-3.8-1.34-.51-1.3-1.25-1.65-1.25-1.65-1.03-.7.08-.69.08-.69 1.14.08 1.74 1.17 1.74 1.17 1.01 1.73 2.65 1.23 3.3.94.1-.73.4-1.23.72-1.51-2.51-.29-5.15-1.26-5.15-5.6 0-1.24.44-2.25 1.17-3.05-.12-.29-.51-1.45.11-3.02 0 0 .95-.3 3.11 1.16A10.8 10.8 0 0 1 12 6.1c.96 0 1.92.13 2.82.39 2.15-1.46 3.1-1.16 3.1-1.16.63 1.57.24 2.73.12 3.02.73.8 1.17 1.81 1.17 3.05 0 4.35-2.65 5.3-5.17 5.59.41.35.77 1.04.77 2.1v3.11c0 .3.2.65.78.54A11.3 11.3 0 0 0 12 .7Z" />
        </svg>
        <span>Source Code</span>
      </a>
    </footer>
  )
}

function HomePage({ steam }: { steam: SteamAuthState }) {
  const [joinCode, setJoinCode] = useState('')
  const [activeRooms, setActiveRooms] = useState<Array<{ code: string; playerCount: number; maxPlayers: number }>>([])
  const [roomsLoading, setRoomsLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let disposed = false
    const loadRooms = async () => {
      try {
        const result = await apiJson<{ rooms: Array<{ code: string; playerCount: number; maxPlayers: number }> }>('/api/rooms')
        if (!disposed) setActiveRooms(result.rooms)
      } catch {
        // The room directory is optional to the create/join flow.
      } finally {
        if (!disposed) setRoomsLoading(false)
      }
    }
    loadRooms()
    const interval = window.setInterval(loadRooms, 10000)
    return () => {
      disposed = true
      window.clearInterval(interval)
    }
  }, [])

  async function createRoom(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const result = await apiJson<{
        roomCode: string
        playerId: string
        token: string
      }>('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({}),
      })
      saveSession({ roomCode: result.roomCode, playerId: result.playerId, token: result.token })
      navigate(`/room/${result.roomCode}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
    } finally {
      setBusy(false)
    }
  }

  function openRoom(event: FormEvent) {
    event.preventDefault()
    const code = normalizeCode(joinCode)
    if (code.length < 4) {
      setError('请输入正确的房间号')
      return
    }
    navigate(`/room/${code}`)
  }

  return (
    <main className="app-shell home-shell">
      <Topbar steam={steam} />
      <div className="page-shell home-content">
        <section className="hero home-hero">
          <h1>CS2 队长选人</h1>
          <p>最多 12 人</p>
        </section>

      <section className="home-grid">
        <form className="panel action-card create-card" onSubmit={createRoom}>
          <div className="action-card-mark">+</div>
          <div className="panel-heading">
            <div>
              <h2>创建房间</h2>
            </div>
          </div>

          <button className="primary-button full-button" disabled={busy || !steam.user} type="submit">
            {busy ? '创建中…' : '创建房间'}
          </button>
        </form>

        <form className="panel action-card join-card" onSubmit={openRoom}>
          <div className="action-card-mark join-mark">↗</div>
          <div className="panel-heading">
            <div>
              <h2>加入房间</h2>
            </div>
          </div>
          <label>
            房间号
            <input
              className="room-code-input"
              value={joinCode}
              onChange={(event) => setJoinCode(normalizeCode(event.target.value))}
              maxLength={6}
              placeholder="ABC123"
              required
            />
          </label>
          <button className="secondary-button full-button" disabled={!steam.user} type="submit">加入房间 <span>→</span></button>
        </form>
      </section>

      <section className="panel active-rooms-panel">
        <div className="section-title-row">
          <div>
            <h2>活跃房间</h2>
          </div>
          <span className="capacity-badge"><i className="live-dot" /> {activeRooms.length} 个</span>
        </div>
        {roomsLoading ? (
          <div className="empty-state compact-empty">正在加载…</div>
        ) : activeRooms.length === 0 ? (
          <div className="empty-state compact-empty">暂无可加入房间</div>
        ) : (
          <div className="active-room-list">
            {activeRooms.map((room) => (
              <button
                className="active-room-card"
                key={room.code}
                type="button"
                onClick={() => navigate(`/room/${room.code}`)}
              >
                <strong>{room.code}</strong>
                <span><i className="status-dot" />{room.playerCount}/{room.maxPlayers} 人</span>
                <b>加入 →</b>
              </button>
            ))}
          </div>
        )}
      </section>
      {error && <div className="toast error-toast">{error}</div>}
      </div>
      <SourceCodeLink />
    </main>
  )
}

function RoomPage({ roomCode, steam }: { roomCode: string; steam: SteamAuthState }) {
  const [session, setSession] = useState<SessionCredentials | null>(() => loadSession(roomCode))
  const [state, setState] = useState<PublicRoomState | null>(null)
  const [connection, setConnection] = useState<'connecting' | 'online' | 'offline'>('connecting')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const socketRef = useRef<WebSocket | null>(null)
  const retryRef = useRef<number | null>(null)
  const retryCountRef = useRef(0)

  useEffect(() => {
    if (!session) return
    let disposed = false

    const connect = () => {
      if (disposed) return
      setConnection('connecting')
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(
        `${protocol}//${window.location.host}/api/rooms/${roomCode}/ws?token=${encodeURIComponent(session.token)}`,
      )
      socketRef.current = socket

      socket.onopen = () => {
        retryCountRef.current = 0
        setConnection('online')
        setError('')
      }
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as ServerMessage
          if (message.type === 'state') setState(message.state)
          if (message.type === 'error') setError(message.message)
          if (message.type === 'notice') setNotice(message.message)
        } catch {
          setError('收到无法识别的服务器消息')
        }
      }
      socket.onclose = (event) => {
        if (disposed) return
        socketRef.current = null
        setConnection('offline')
        if (event.code === 4401 || event.code === 4404) {
          localStorage.removeItem(`${SESSION_PREFIX}${roomCode}`)
          setSession(null)
          setState(null)
          setError(event.code === 4404 ? '房间不存在或已经关闭' : '身份已失效，请重新加入')
          return
        }
        const delay = Math.min(1000 * 2 ** retryCountRef.current, 10000)
        retryCountRef.current += 1
        retryRef.current = window.setTimeout(connect, delay)
      }
      socket.onerror = () => socket.close()
    }

    connect()
    return () => {
      disposed = true
      if (retryRef.current) window.clearTimeout(retryRef.current)
      socketRef.current?.close(1000, 'page changed')
    }
  }, [roomCode, session])

  useEffect(() => {
    if (!session || !state) return
    if (state.players.some((player) => player.id === session.playerId)) return
    localStorage.removeItem(`${SESSION_PREFIX}${roomCode}`)
    setState(null)
    setSession(null)
    setError('你已经不在这个房间中，请重新加入')
  }, [roomCode, session, state])

  function send(action: ClientAction) {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setError('连接尚未恢复，请稍后再试')
      return
    }
    socketRef.current.send(JSON.stringify(action))
  }

  if (!session) {
    return <JoinRoom roomCode={roomCode} steam={steam} onJoined={setSession} error={error} setError={setError} />
  }

  if (!state) {
    return (
      <main className="app-shell centered-shell">
        <Topbar steam={steam} roomCode={roomCode} />
        <div className="loading-card">
          <div className="spinner" />
          <h2>正在连接房间 {roomCode}</h2>
          <p>{connection === 'offline' ? '连接中断，正在自动重连…' : '正在建立 WebSocket 连接…'}</p>
          {error && <div className="inline-error">{error}</div>}
        </div>
        <SourceCodeLink />
      </main>
    )
  }

  const me = state.players.find((player) => player.id === session.playerId) ?? null
  if (!me) return null

  return <RoomDashboard state={state} me={me} steam={steam} connection={connection} error={error} notice={notice} send={send} />
}

function JoinRoom({
  roomCode,
  steam,
  onJoined,
  error,
  setError,
}: {
  roomCode: string
  steam: SteamAuthState
  onJoined: (session: SessionCredentials) => void
  error: string
  setError: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)

  async function join(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const result = await apiJson<{ playerId: string; token: string }>(`/api/rooms/${roomCode}/join`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      const nextSession = { roomCode, playerId: result.playerId, token: result.token }
      saveSession(nextSession)
      onJoined(nextSession)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加入失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="app-shell centered-shell">
      <Topbar steam={steam} roomCode={roomCode} />
      <form className="panel join-panel" onSubmit={join}>
        <button type="button" className="text-button back-button" onClick={() => navigate('/')}>← 返回首页</button>
        <div className="room-code-badge">房间 / {roomCode}</div>
        <h1>加入房间</h1>
        {steam.user && <div className="join-profile"><img src={steam.user.avatarUrl} alt="" /><span>{steam.user.steamName}</span><i>已准备</i></div>}
        {steam.user ? (
          <button className="primary-button" disabled={busy} type="submit">
            {busy ? '正在加入…' : '加入房间'}
          </button>
        ) : (
          <button className="steam-login-button" onClick={() => steamLogin(`/room/${roomCode}`)} type="button">使用 Steam 登录</button>
        )}
        {error && <div className="inline-error">{error}</div>}
      </form>
      <SourceCodeLink />
    </main>
  )
}

function RoomDashboard({
  state,
  me,
  steam,
  connection,
  error,
  notice,
  send,
}: {
  state: PublicRoomState
  me: PublicPlayer
  steam: SteamAuthState
  connection: 'connecting' | 'online' | 'offline'
  error: string
  notice: string
  send: (action: ClientAction) => void
}) {
  const playerMap = useMemo(() => new Map(state.players.map((player) => [player.id, player])), [state.players])
  const [captainAId, setCaptainAId] = useState(state.captainAId ?? '')
  const [captainBId, setCaptainBId] = useState(state.captainBId ?? '')

  useEffect(() => {
    setCaptainAId(state.captainAId ?? '')
    setCaptainBId(state.captainBId ?? '')
  }, [state.captainAId, state.captainBId])

  const currentCaptainId = state.currentTurn === 'A' ? state.captainAId : state.currentTurn === 'B' ? state.captainBId : null
  const canPick = state.status === 'drafting' && currentCaptainId === me.id && connection === 'online'

  async function copyInvite() {
    await navigator.clipboard.writeText(window.location.href)
  }

  async function copyResult() {
    const teamText = (side: TeamSide, ids: string[]) => {
      const names = ids.map((id, index) => `${index + 1}. ${playerMap.get(id)?.name ?? id}`)
      return `【${side} 队】\n${names.join('\n')}`
    }
    const mapName = state.maps.find((map) => map.id === state.selectedMapId)?.name
    const mapText = mapName ? `\n\nBO1 地图：${mapName}` : ''
    await navigator.clipboard.writeText(`${teamText('A', state.teamAIds)}\n\n${teamText('B', state.teamBIds)}${mapText}`)
  }

  return (
    <main className="app-shell room-app-shell">
      <Topbar steam={steam} roomCode={state.code} />
      <div className="page-shell room-shell">
      <header className="room-header">
        <div>
          <div className="eyebrow">实时选人</div>
          <h1>房间 {state.code}</h1>
          <p>{state.status === 'waiting' ? '最多 12 人' : `${state.players.length} 人 · A/B ${state.teamSize}/${state.capacity - state.teamSize}`}</p>
        </div>
        <div className="header-actions">
          <span className={`connection-pill ${connection}`}>
            <span className="status-dot" />
            {connection === 'online' ? '实时连接' : connection === 'connecting' ? '连接中' : '正在重连'}
          </span>
          <button className="secondary-button compact" onClick={copyInvite}>复制邀请链接</button>
        </div>
      </header>

      <section className="room-summary">
        <div><span className="summary-label">人数</span><strong>{state.players.length}</strong><span>/ {state.status === 'waiting' ? 12 : state.capacity}</span></div>
        <div><span className="summary-label">状态</span><strong>{statusLabel(state.status)}</strong></div>
        <div><span className="summary-label">选人</span><strong>{state.pickIndex}</strong><span>/ {state.totalPicks}</span></div>
      </section>

      <RoomPhaseRail status={state.status} />

      {error && <div className="toast error-toast room-toast">{error}</div>}
      {notice && <div className="toast notice-toast room-toast">{notice}</div>}

      {state.status === 'waiting' && (
        <WaitingRoom
          state={state}
          me={me}
          captainAId={captainAId}
          captainBId={captainBId}
          setCaptainAId={setCaptainAId}
          setCaptainBId={setCaptainBId}
          send={send}
        />
      )}

      {state.status === 'pick_decision' && <PickOrderDecision state={state} me={me} send={send} />}

      {(state.status === 'drafting' || state.status === 'finished') && (
        <DraftBoard state={state} me={me} canPick={canPick} playerMap={playerMap} send={send} copyResult={copyResult} />
      )}

      {state.status === 'map_veto' && <MapVetoBoard state={state} me={me} connection={connection} playerMap={playerMap} send={send} />}

      {state.status === 'map_finished' && <MapResult state={state} me={me} playerMap={playerMap} send={send} copyResult={copyResult} />}

      {state.status === 'match_started' && <MatchStarted state={state} me={me} playerMap={playerMap} send={send} copyResult={copyResult} />}

      {state.status === 'closed' && (
        <section className="panel closed-panel">
          <h2>房间已关闭</h2>
          <p>房主已经结束了这个房间。</p>
          <button className="primary-button" onClick={() => navigate('/')}>返回首页</button>
        </section>
      )}
      </div>
      <SourceCodeLink />
    </main>
  )
}

function RoomPhaseRail({ status }: { status: PublicRoomState['status'] }) {
  const phaseIndex = status === 'waiting' ? 0 : status === 'pick_decision' ? 1 : status === 'drafting' || status === 'finished' ? 2 : status === 'map_veto' ? 3 : 4
  const phases = ['大厅', '队长', '选人', '禁图', '比赛']
  return (
    <div className="phase-rail" aria-label="房间阶段">
      {phases.map((phase, index) => (
        <div className={`phase-item ${index < phaseIndex ? 'done' : ''} ${index === phaseIndex ? 'current' : ''}`} key={phase}>
          <span>{index < phaseIndex ? '✓' : `0${index + 1}`}</span>
          <b>{phase}</b>
        </div>
      ))}
    </div>
  )
}

function WaitingRoom({
  state,
  me,
  captainAId,
  captainBId,
  setCaptainAId,
  setCaptainBId,
  send,
}: {
  state: PublicRoomState
  me: PublicPlayer
  captainAId: string
  captainBId: string
  setCaptainAId: (id: string) => void
  setCaptainBId: (id: string) => void
  send: (action: ClientAction) => void
}) {
  const canSetCaptains = state.players.length >= 2
  const canStart = state.players.length >= 2 && Boolean(state.captainAId && state.captainBId)
  return (
    <div className="waiting-layout">
      <section className="panel player-list-panel">
        <div className="section-title-row">
          <div>
            <h2>玩家列表</h2>
          </div>
          <span className="capacity-badge">{state.players.length}/12</span>
        </div>
        <div className="players-grid">
          {state.players.map((player) => (
            <PlayerCard
              key={player.id}
              player={player}
              action={me.isHost && !player.isHost ? (
                <button className="danger-link" onClick={() => send({ type: 'kick_player', playerId: player.id })}>移出</button>
              ) : null}
            />
          ))}
        </div>
      </section>

      <aside className="panel control-panel">
        <h2>队长设置</h2>
        <p className="hint">可以手动设置两位队长。</p>
        {!me.isHost && <p className="muted">等待房主操作</p>}
        {me.isHost && (
          <>
            <label>
              A 队队长
              <select value={captainAId} onChange={(event) => setCaptainAId(event.target.value)}>
                <option value="">请选择</option>
                {state.players.map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}
              </select>
            </label>
            <label>
              B 队队长
              <select value={captainBId} onChange={(event) => setCaptainBId(event.target.value)}>
                <option value="">请选择</option>
                {state.players.map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}
              </select>
            </label>
            <div className="button-stack">
              <button
                className="secondary-button"
                disabled={!canSetCaptains}
                onClick={() => send({ type: 'random_captains' })}
              >随机队长</button>
              <button
                className="secondary-button"
                disabled={!canSetCaptains || !captainAId || !captainBId || captainAId === captainBId}
                onClick={() => send({ type: 'set_captains', captainAId, captainBId })}
              >设置队长</button>
              <button
                className="primary-button"
                disabled={!canStart}
                onClick={() => send({ type: 'start_draft' })}
              >开始选人</button>
            </div>
          </>
        )}
        {(state.captainAId || state.captainBId) && (
          <div className="captain-preview">
            <CaptainLine side="A" player={state.players.find((p) => p.id === state.captainAId)} />
            <CaptainLine side="B" player={state.players.find((p) => p.id === state.captainBId)} />
          </div>
        )}
      </aside>
    </div>
  )
}

function PickOrderDecision({
  state,
  me,
  send,
}: {
  state: PublicRoomState
  me: PublicPlayer
  send: (action: ClientAction) => void
}) {
  const winnerCaptainId = state.rollWinner === 'A' ? state.captainAId : state.captainBId
  const winnerName = state.players.find((player) => player.id === winnerCaptainId)?.name ?? '队长'
  const canDecide = me.id === winnerCaptainId

  return (
    <>
      <section className="turn-banner">
        <strong>点数决定先后手</strong>
        <span>{winnerName} 点数最高，可选择先选或后选</span>
      </section>

      <section className="panel pick-decision-panel">
        <div className="roll-grid">
          <div className={`roll-card ${state.rollWinner === 'A' ? 'winner' : ''}`}>
            <span>A 队</span>
            <strong>{state.rollA ?? '—'}</strong>
          </div>
          <div className={`roll-card ${state.rollWinner === 'B' ? 'winner' : ''}`}>
            <span>B 队</span>
            <strong>{state.rollB ?? '—'}</strong>
          </div>
        </div>
        {canDecide ? (
          <div className="button-stack pick-decision-actions">
            <button className="primary-button" onClick={() => send({ type: 'choose_pick_order', firstPick: true })}>先选</button>
            <button className="secondary-button" onClick={() => send({ type: 'choose_pick_order', firstPick: false })}>后选</button>
          </div>
        ) : (
          <p className="hint pick-decision-wait">等待 {winnerName} 选择先后手</p>
        )}
      </section>
    </>
  )
}

function DraftBoard({
  state,
  me,
  canPick,
  playerMap,
  send,
  copyResult,
}: {
  state: PublicRoomState
  me: PublicPlayer
  canPick: boolean
  playerMap: Map<string, PublicPlayer>
  send: (action: ClientAction) => void
  copyResult: () => void
}) {
  const currentCaptain = state.currentTurn === 'A' ? playerMap.get(state.captainAId ?? '') : playerMap.get(state.captainBId ?? '')
  return (
    <>
      <section className={`turn-banner ${state.status === 'finished' ? 'finished' : ''}`}>
        {state.status === 'finished' ? (
          <><strong>选人完成</strong><span>最终阵容已经锁定，可以复制到群聊。</span></>
        ) : (
          <>
            <strong>当前轮到 {state.currentTurn} 队</strong>
            <span>{currentCaptain?.name ?? '队长'} 选择一名玩家 {canPick ? '· 现在由你操作' : ''}</span>
          </>
        )}
      </section>

      <section className="draft-grid">
        <TeamColumn side="A" ids={state.teamAIds} playerMap={playerMap} captainId={state.captainAId} />

        <div className="available-column panel">
          <div className="section-title-row">
            <div>
              <h2>待选玩家</h2>
              <p>{state.availablePlayerIds.length} 人可选</p>
            </div>
            <span className="pick-counter">{state.pickIndex}/{state.totalPicks}</span>
          </div>
          <div className="available-list">
            {state.availablePlayerIds.map((id) => {
              const player = playerMap.get(id)
              if (!player) return null
              return (
                <button
                  className={`pick-player-card ${canPick ? 'selectable' : ''}`}
                  disabled={!canPick}
                  key={id}
                  onClick={() => send({ type: 'pick_player', playerId: id })}
                >
                  <span className={`presence ${player.online ? 'online' : ''}`} />
                  <span><strong>{player.name}</strong></span>
                  {canPick && <b>选择</b>}
                </button>
              )
            })}
            {state.availablePlayerIds.length === 0 && <div className="empty-state">所有玩家均已分队</div>}
          </div>
        </div>

        <TeamColumn side="B" ids={state.teamBIds} playerMap={playerMap} captainId={state.captainBId} />
      </section>

      <section className="draft-footer">
        {state.status === 'finished' && me.isHost && <button className="primary-button compact" onClick={() => send({ type: 'start_map_veto' })}>开始地图禁选</button>}
        {state.status === 'finished' && <button className="secondary-button compact" onClick={copyResult}>复制阵容</button>}
        {me.isHost && <button className="secondary-button compact" onClick={() => send({ type: 'reset_room' })}>重置房间</button>}
        {me.isHost && <button className="danger-button compact" onClick={() => send({ type: 'close_room' })}>关闭房间</button>}
      </section>
    </>
  )
}

function MapVetoBoard({
  state,
  me,
  connection,
  playerMap,
  send,
}: {
  state: PublicRoomState
  me: PublicPlayer
  connection: 'connecting' | 'online' | 'offline'
  playerMap: Map<string, PublicPlayer>
  send: (action: ClientAction) => void
}) {
  const currentCaptainId = state.mapTurn === 'A' ? state.captainAId : state.mapTurn === 'B' ? state.captainBId : null
  const currentCaptain = currentCaptainId ? playerMap.get(currentCaptainId) : null
  const canBan = Boolean(state.mapTurn && currentCaptainId === me.id && connection === 'online')

  return (
    <>
      <section className="turn-banner">
        <strong>地图禁选</strong>
        <span>{currentCaptain?.name ?? '队长'} 禁用一张地图 {canBan ? '· 现在由你操作' : ''}</span>
      </section>

      <section className="panel map-veto-panel">
        <div className="section-title-row">
          <div>
            <h2>BO1 地图池</h2>
            <p>已禁 {state.mapBanIndex}/{state.mapTotalBans}</p>
          </div>
          <span className="pick-counter">剩 {state.maps.length - state.bannedMapIds.length}</span>
        </div>
        <div className="map-grid">
          {state.maps.map((map) => {
            const banned = state.bannedMapIds.includes(map.id)
            return (
              <button
                key={map.id}
                className={`map-card ${banned ? 'banned' : canBan ? 'selectable' : ''}`}
                disabled={banned || !canBan}
                onClick={() => send({ type: 'ban_map', mapId: map.id })}
              >
                <strong>{map.name}</strong>
                <span>{banned ? '已禁用' : canBan ? '禁用' : '等待'}</span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="draft-footer">
        {me.isHost && <button className="secondary-button compact" onClick={() => send({ type: 'reset_room' })}>重置房间</button>}
        {me.isHost && <button className="danger-button compact" onClick={() => send({ type: 'close_room' })}>关闭房间</button>}
      </section>
    </>
  )
}

function MapResult({
  state,
  me,
  playerMap,
  send,
  copyResult,
}: {
  state: PublicRoomState
  me: PublicPlayer
  playerMap: Map<string, PublicPlayer>
  send: (action: ClientAction) => void
  copyResult: () => void
}) {
  const selectedMap = state.maps.find((map) => map.id === state.selectedMapId)

  return (
    <>
      <section className="turn-banner finished">
        <strong>BO1 地图：{selectedMap?.name ?? '未确定'}</strong>
        <span>地图禁选完成</span>
      </section>

      <section className="panel map-result-panel">
        <div className="result-kicker">对局结果</div>
        <div className="map-result-name">{selectedMap?.name ?? '未确定'}</div>
        <div className="map-ban-summary">
          {state.maps.filter((map) => state.bannedMapIds.includes(map.id)).map((map) => (
            <span key={map.id}>{map.name}</span>
          ))}
        </div>
      </section>

      <FinalTeams state={state} playerMap={playerMap} />

      <section className="draft-footer">
        {me.isHost && <button className="primary-button compact" onClick={() => send({ type: 'start_match' })}>开始竞技比赛</button>}
        <button className="primary-button compact" onClick={copyResult}>复制对局信息</button>
        {me.isHost && <button className="secondary-button compact" onClick={() => send({ type: 'reset_room' })}>重置房间</button>}
        {me.isHost && <button className="danger-button compact" onClick={() => send({ type: 'close_room' })}>关闭房间</button>}
      </section>
    </>
  )
}

function MatchStarted({
  state,
  me,
  playerMap,
  send,
  copyResult,
}: {
  state: PublicRoomState
  me: PublicPlayer
  playerMap: Map<string, PublicPlayer>
  send: (action: ClientAction) => void
  copyResult: () => void
}) {
  const selectedMap = state.maps.find((map) => map.id === state.selectedMapId)
  const connectUrl = gameConnectUrl(state)
  const serverAddress = state.gameServerHost && state.gameServerPort
    ? `${state.gameServerHost}:${state.gameServerPort}`
    : '服务器地址未配置'
  return (
    <section className="panel map-result-panel">
      <h2>比赛已开始</h2>
      <div className="map-result-name">{selectedMap?.name ?? '地图已加载'}</div>
      <p className="muted">玩家可以自由加入 CT、T 或观战。</p>
      <div className="match-connect-card">
        <div>
          <span>服务器地址</span>
          <strong>{serverAddress}</strong>
        </div>
        {connectUrl ? (
          <a className="primary-button" href={connectUrl} target="_blank" rel="noopener noreferrer">进入游戏</a>
        ) : (
          <span className="muted">无法获取服务器地址</span>
        )}
      </div>
      <FinalTeams state={state} playerMap={playerMap} />
      <div className="draft-footer">
        <button className="secondary-button compact" onClick={copyResult}>复制对局信息</button>
        {me.isHost && <button className="secondary-button compact" onClick={() => send({ type: 'reset_room' })}>重置房间</button>}
      </div>
    </section>
  )
}

function FinalTeams({ state, playerMap }: { state: PublicRoomState; playerMap: Map<string, PublicPlayer> }) {
  return (
    <section className="final-teams-grid">
      <TeamColumn side="A" ids={state.teamAIds} playerMap={playerMap} captainId={state.captainAId} />
      <TeamColumn side="B" ids={state.teamBIds} playerMap={playerMap} captainId={state.captainBId} />
    </section>
  )
}

function gameConnectUrl(state: PublicRoomState): string | null {
  const host = state.gameServerHost?.trim()
  const port = state.gameServerPort
  if (!host || !port) return null
  return `steam://connect/${host}:${port}`
}

function TeamColumn({
  side,
  ids,
  playerMap,
  captainId,
}: {
  side: TeamSide
  ids: string[]
  playerMap: Map<string, PublicPlayer>
  captainId: string | null
}) {
  return (
    <section className={`team-column panel team-${side.toLowerCase()}`}>
      <div className="team-heading">
        <span>{side}</span>
        <div><h2>{side} 队</h2><p>{ids.length} 名玩家</p></div>
      </div>
      <div className="team-player-list">
        {ids.map((id, index) => {
          const player = playerMap.get(id)
          if (!player) return null
          return (
            <div className="team-player" key={id}>
              <span className="player-index">{index + 1}</span>
              <PlayerAvatar player={player} />
              <span><strong>{player.name}</strong></span>
              {id === captainId && <b className="captain-tag">队长</b>}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function PlayerCard({ player, action }: { player: PublicPlayer; action: React.ReactNode }) {
  return (
    <div className="player-card">
      <PlayerAvatar player={player} />
      <div>
        <strong>{player.name}</strong>
      </div>
      <div className="player-flags">
        {player.isHost && <span>房主</span>}
        {player.isCaptainA && <span>A 队长</span>}
        {player.isCaptainB && <span>B 队长</span>}
      </div>
      {action}
    </div>
  )
}

function PlayerAvatar({ player }: { player: PublicPlayer }) {
  return player.avatarUrl ? (
    <img className={`player-avatar ${player.online ? 'online' : ''}`} src={player.avatarUrl} alt="" />
  ) : (
    <span className={`player-avatar player-avatar-fallback ${player.online ? 'online' : ''}`}>{player.name.slice(0, 1)}</span>
  )
}

function CaptainLine({ side, player }: { side: TeamSide; player?: PublicPlayer }) {
  return (
    <div>
      <span className={`team-letter team-letter-${side.toLowerCase()}`}>{side}</span>
      <span>{player?.name ?? '未设置'}</span>
    </div>
  )
}

function statusLabel(status: PublicRoomState['status']) {
  return {
    waiting: '等待中',
    pick_decision: '决定先后手',
    drafting: '选人中',
    finished: '已完成',
    map_veto: '地图禁选',
    map_finished: '地图已定',
    match_started: '竞技比赛中',
    closed: '已关闭',
  }[status]
}
