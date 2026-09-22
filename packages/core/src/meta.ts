export type SnapshotSource = 'watch' | 'agent' | 'manual' | 'pre-restore';

export interface SnapshotMeta {
  v: 1;
  label: string;
  source: SnapshotSource;
  /** Which editor's agent produced this, when known. */
  agent?: string;
  /** Opaque id linking a begin/end pair from the same agent turn. */
  turn?: string;
  /** Branch checked out in the real repository at snapshot time. */
  branch: string;
  /** The real HEAD commit this snapshot sits on top of, if any. */
  head: string | null;
}

const BODY_SEPARATOR = '\ncoderep-meta: ';

/** Builds a commit message whose subject is human-readable and whose body carries the metadata. */
export function encodeMessage(meta: SnapshotMeta): string {
  const subject = `coderep(${meta.source}): ${meta.label || 'snapshot'}`.replace(/\s+/g, ' ').slice(0, 200);
  return `${subject}\n${BODY_SEPARATOR}${JSON.stringify(meta)}\n`;
}

/** Recovers the metadata, tolerating commits written by an older version. */
export function decodeMessage(message: string): SnapshotMeta {
  const index = message.indexOf(BODY_SEPARATOR.trim());
  if (index !== -1) {
    const json = message.slice(index + BODY_SEPARATOR.trim().length).trim();
    try {
      const parsed = JSON.parse(json) as SnapshotMeta;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // fall through to the default below
    }
  }
  return {
    v: 1,
    label: message.split('\n')[0] ?? 'snapshot',
    source: 'manual',
    branch: 'unknown',
    head: null,
  };
}
