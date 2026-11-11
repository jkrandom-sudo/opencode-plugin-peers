import { closeSync, fsyncSync, openSync } from "node:fs"

const WINDOWS_UNSUPPORTED_DIRECTORY_FSYNC_CODES = new Set(["EPERM", "EINVAL", "ENOTSUP", "EISDIR"])

/** Persist a directory entry update where the platform supports directory fsync. */
export function syncDirectory(directory: string): void {
  let dirFd: number | undefined
  try {
    dirFd = openSync(directory, "r")
    fsyncSync(dirFd)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ""
    if (process.platform === "win32" && WINDOWS_UNSUPPORTED_DIRECTORY_FSYNC_CODES.has(code)) return
    throw error
  } finally {
    if (dirFd !== undefined) closeSync(dirFd)
  }
}
