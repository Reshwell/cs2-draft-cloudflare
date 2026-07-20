export type RoomStatus = 'waiting' | 'pick_decision' | 'drafting' | 'finished' | 'map_veto' | 'side_select' | 'map_finished' | 'match_started' | 'closed'
export type TeamSide = 'A' | 'B'
export type StartingSide = 'T' | 'CT'

export interface MapOption {
  id: string
  name: string
}

export interface PublicPlayer {
  id: string
  name: string
  steamId: string | null
  avatarUrl: string | null
  rankScore: number | null
  rankTier: string | null
  joinedAt: number
  online: boolean
  isHost: boolean
  isCaptainA: boolean
  isCaptainB: boolean
  team: TeamSide | null
}

export interface PublicRoomState {
  code: string
  gameServerHost: string | null
  gameServerPort: number | null
  status: RoomStatus
  capacity: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12
  teamSize: number
  hostPlayerId: string
  captainAId: string | null
  captainBId: string | null
  teamAIds: string[]
  teamBIds: string[]
  availablePlayerIds: string[]
  currentTurn: TeamSide | null
  pickIndex: number
  totalPicks: number
  players: PublicPlayer[]
  createdAt: number
  updatedAt: number
  maps: MapOption[]
  bannedMapIds: string[]
  mapTurn: TeamSide | null
  mapBanIndex: number
  mapTotalBans: number
  selectedMapId: string | null
  startingSide: StartingSide | null
  rollA: number | null
  rollB: number | null
  rollWinner: TeamSide | null
  firstPickSide: TeamSide | null
  matchStartedAt: number | null
}

export interface SessionCredentials {
  roomCode: string
  playerId: string
  token: string
}

export interface SteamUser {
  steamId: string
  steamName: string
  avatarUrl: string
}

export type ClientAction =
  | { type: 'set_captains'; captainAId: string; captainBId: string }
  | { type: 'random_captains' }
  | { type: 'start_draft' }
  | { type: 'choose_pick_order'; firstPick: boolean }
  | { type: 'start_map_veto' }
  | { type: 'ban_map'; mapId: string }
  | { type: 'choose_starting_side'; startingSide: StartingSide }
  | { type: 'pick_player'; playerId: string }
  | { type: 'kick_player'; playerId: string }
  | { type: 'start_match' }
  | { type: 'reset_room' }
  | { type: 'close_room' }

export type ServerMessage =
  | { type: 'state'; state: PublicRoomState }
  | { type: 'error'; message: string }
  | { type: 'notice'; message: string }
