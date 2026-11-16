// The Overview PDF route, shared by the phone and the dev server (step 1.4 A5).
//
// What goes into the PDF (the query checks, the data, the HTML page) is core/overview-pdf.js.
// Turning that page into PDF bytes is the platform's job, through ctx.host.pdf.render
// (core/host.js): Playwright on the dev server, the print-adapter plugin on the phone. A refusal
// the user should see (busy, needs the Android app, ...) arrives as a hostError and is passed on
// with its own status and message; anything else is a 500.

export function register(app, ctx) {
  const { auth, host, istDateStamp, logError, readPdfQuery, overviewPdfHtml } = ctx;

  app.get('/api/overview/pdf', auth, async (req, res) => {
    const q = readPdfQuery(req.query);
    if (q.error) return res.status(400).json({ error: q.error });
    const { part, theme, range } = q;
    // Checked BEFORE the render, so bad requests never take one of the server's render slots.
    try {
      const pdf = await host.pdf.render(overviewPdfHtml({ part, theme, range }), { part });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="plannr-overview-${part}-${istDateStamp()}.pdf"`); // IST date, not UTC
      res.send(pdf);
    } catch (err) {
      if (!err.status || err.cause) logError('PDF generation failed:', err.cause || err); // a plain refusal ("busy") is not logged
      res.status(err.status || 500).json({ error: err.userMessage || 'Could not generate the PDF: ' + (err && err.message ? err.message : String(err)) });
    }
  });
}
