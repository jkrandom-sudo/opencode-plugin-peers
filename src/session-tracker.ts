/**
 * Tracks the "active" session of this opencode server instance and whether
 * it is idle. opencode plugins are per-server, not per-session, so the
 * active session is a heuristic: the session that most recently produced
 * user activity.
 */

export interface SessionTrackerInstance {
  activeSessionId: () => string | null
  activeSessionTitle: () => string | null
  isIdle: () => boolean
  noteUserActivity: (sessionId: string, title?: string | null) => void
  noteIdle: (sessionId?: string) => void
  noteBusy: (sessionId?: string) => void
  noteDeleted: (sessionId: string) => void
}

export function SessionTracker(): SessionTrackerInstance {
  let activeId: string | null = null
  let activeTitle: string | null = null
  let idle = true

  return {
    activeSessionId: () => activeId,
    activeSessionTitle: () => activeTitle,
    isIdle: () => idle,

    noteUserActivity(sessionId, title) {
      activeId = sessionId
      if (title) activeTitle = title
      idle = false
    },

    noteIdle(sessionId) {
      if (!sessionId || sessionId === activeId) idle = true
      if (!activeId && sessionId) activeId = sessionId
    },

    noteBusy(sessionId) {
      if (!sessionId || sessionId === activeId) idle = false
    },

    noteDeleted(sessionId) {
      if (activeId === sessionId) {
        activeId = null
        activeTitle = null
        idle = true
      }
    },
  }
}
