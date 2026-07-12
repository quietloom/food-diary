import { startSession, endSession, getAllSessions } from './db.js';

/** Wraps db.js's sessions store as a start/stop stopwatch for the
 * dietitian's manual Nutritics-keying pass — the evidence artifact for the
 * Libro business case (spec §Timing instrumentation). */
export function createTimer(db, { now = Date.now } = {}) {
  let currentSessionId = null;

  return {
    isRunning() {
      return currentSessionId !== null;
    },
    async start() {
      currentSessionId = await startSession(db, now);
    },
    async stop(entriesLogged) {
      if (currentSessionId === null) {
        throw new Error('no session in progress — call start() first');
      }
      await endSession(db, currentSessionId, entriesLogged, now);
      currentSessionId = null;
    },
    async summary() {
      const sessions = await getAllSessions(db);
      const finished = sessions.filter((s) => s.endedAt !== null);
      return {
        totalMs: finished.reduce((sum, s) => sum + (s.endedAt - s.startedAt), 0),
        totalEntries: finished.reduce((sum, s) => sum + (s.entriesLogged || 0), 0),
        passCount: finished.length,
      };
    },
  };
}
