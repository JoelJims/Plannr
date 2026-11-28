// The device's own (local) calendar date, for the Overview PDF's file name and the email subject's
// {date} (owner's decision: PDF file names use the LOCAL date). Shared by the Overview page
// (public/overview.html), public/share-pdf.js and the PDF route (core/routes/pdf.js, which on the
// phone runs on the phone itself), so the file name and the subject always carry the same date.
// Not the UTC date (toISOString): in India that is a day behind between 00:00 and 05:30, so a PDF
// made at 01:30 was named for the day before while its email subject said today.

// The local date of a moment as 'YYYY-MM-DD'.
export function localDateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// The Overview PDF's file name for one part ('full', 'pie', 'table', 'ledger'), with the local date.
export function overviewPdfName(part, d = new Date()) {
  return `plannr-overview-${part}-${localDateStamp(d)}.pdf`;
}
