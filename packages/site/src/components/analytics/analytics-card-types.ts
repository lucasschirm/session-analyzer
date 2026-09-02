/** Direction of a delta chip. Never inferred from a numeric sign here — the
 * page/query layer decides direction; components only place it. */
export type DeltaDirection = 'up' | 'down' | 'flat';

/** Display-ready delta chip contents. `text` is already formatted (e.g. "+12%"). */
export interface StatDelta {
  direction: DeltaDirection;
  text: string;
}

/** A single labeled+colored row in a stat tile's sub-breakdown. */
export interface StatBreakdownItem {
  label: string;
  value: string;
  color: string;
}

/** A single item rendered by `stat-strip`. */
export interface StatStripItem {
  label: string;
  value: string;
  sampleLabel?: string;
}

/** `card-click` CustomEvent detail, shared by every clickable analytics tile. */
export interface CardClickDetail {
  label: string;
}
