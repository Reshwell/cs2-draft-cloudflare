export type RoomStatus = 'waiting' | 'pick_decision' | 'drafting' | 'finished' | 'map_veto' | 'map_finished' | 'closed'
export type TeamSide = 'A' | 'B'

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
  rollA: number | null
  rollB: number | null
  rollWinner: TeamSide | null
  firstPickSide: TeamSide | null
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
  | { type: 'pick_player'; playerId: string }
  | { type: 'kick_player'; playerId: string }
  | { type: 'reset_room' }
  | { type: 'close_room' }

export type ServerMessage =
  | { type: 'state'; state: PublicRoomState }
  | { type: 'error'; message: string }
  | { type: 'notice'; message: string }
