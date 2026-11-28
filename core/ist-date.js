// IST (Asia/Kolkata) dates, shared by the dev server (server.js) and the phone (public/local-api.js).
// Used for the ledger-list CSV's file name and the Overview's upcoming-payment day counts. (The
// Overview PDF's file name uses the device's own date instead: core/local-date.js.) IST has no
// daylight saving time, so a date stamp needs no seasonal rules.
export const IST_TZ = 'Asia/Kolkata';

// The IST date of a moment as 'YYYY-MM-DD' (the en-CA locale writes dates in that order).
export function istDateStamp(d = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: IST_TZ }).format(d); }
