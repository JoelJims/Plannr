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
// (core/storage-move.js still writes its own move-back message, "Your data (X) is too big to move
// back: the old storage holds at most about Y", with the same rounding up but no "under 0.1 MB":
// Y is a capacity, not a size of your data.)

export const MB = 1024 * 1024;

/** The size of `bytes` as text: "under 0.1 MB", or rounded up to 0.1 MB, like "0.3 MB" or "25.0 MB". */
export function mbText(bytes) {
  const b = Math.max(0, Number(bytes) || 0);
  if (b < MB / 10) return 'under 0.1 MB';
  // bytes x 10 / MB, not bytes / MB x 10: the integer product divides exactly by a power of two, so
  // a size of exactly 0.5 MB is 5 tenths, never 5.000000001 rounded up to 0.6.
  return `${(Math.ceil((b * 10) / MB) / 10).toFixed(1)} MB`;
}
