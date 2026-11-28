// How Plannr writes the size of your data in MB, in one place, so a size reads the same wherever
// it is shown. The Data Backup page shows the old copy's size in two places (the storage meter and
// the storage-move section) and used to round it two ways: 0.21 MB read "0.2 MB" in one and
// "0.3 MB" in the other.
//
// Rounded UP to the next 0.1 MB. A size here is read against a limit (Android's Google backup skips
// Plannr over 25 MB; the old storage has a fixed limit too) or as what deleting something frees, so
// it must never read smaller than it is. Below 0.1 MB it says "under 0.1 MB", which is exact, where
// rounding up would show a few kilobytes as "0.1 MB".
// MB here is 1024 x 1024 bytes, as everywhere in Plannr (core/storage-move.js, core/routes/storage.js).
//
// A capacity, how much room something has, is the other way round: capacityText() rounds DOWN to
// 0.1 MB, so the room never reads larger than it is (core/storage-move.js: never overstate what is
// free). Below 0.1 MB it says "less than 0.1 MB", which is true where "0.0 MB" would say there is no
// room at all. The move-back refusal in core/storage-move.js uses both: "Your data (X) is too big to
// move back: the old storage holds at most about Y", X by mbText() and Y by capacityText(), so from
// 0.1 MB up X reads larger than Y (with both rounded up, 2.26 MB against 2.25 MB read 2.3 MB and
// 2.3 MB). Below 0.1 MB both read "under / less than 0.1 MB"; X never reads smaller than Y.

export const MB = 1024 * 1024;

/** The size of `bytes` as text: "under 0.1 MB", or rounded up to 0.1 MB, like "0.3 MB" or "25.0 MB". */
export function mbText(bytes) {
  const b = Math.max(0, Number(bytes) || 0);
  if (b < MB / 10) return 'under 0.1 MB';
  // bytes x 10 / MB, not bytes / MB x 10: the integer product divides exactly by a power of two, so
  // a size of exactly 0.5 MB is 5 tenths, never 5.000000001 rounded up to 0.6.
  return `${(Math.ceil((b * 10) / MB) / 10).toFixed(1)} MB`;
}

/** A capacity of `bytes` as text: "less than 0.1 MB", or rounded down to 0.1 MB, like "2.2 MB". */
export function capacityText(bytes) {
  const b = Math.max(0, Number(bytes) || 0);
  if (b < MB / 10) return 'less than 0.1 MB';
  return `${(Math.floor((b * 10) / MB) / 10).toFixed(1)} MB`; // bytes x 10 / MB: as in mbText()
}
