// The Overview PDF route, shared by the phone and the dev server (step 1.4 A5).
//
// What goes into the PDF (the query checks, the data, the HTML page) is core/overview-pdf.js.
// Turning that page into PDF bytes is the platform's job, through ctx.host.pdf.render
// (core/host.js): Playwright on the dev server, the print-adapter plugin on the phone. A refusal
// the user should see (busy, needs the Android app, ...) arrives as a hostError and is passed on
// with its own status and message; anything else is a 500.
//
// Step 1.4 B5: the one route outside the request queue (core/request-queue.js). Its page is built
// from the database inside the queue (ctx.exclusive); the render, which takes seconds and needs no
// database, runs outside it, so a PDF does not hold up the next request.

import { outsideQueue } from '../request-queue.js';
import { overviewPdfName } from '../local-date.js';

export function register(app, ctx) {
  const { auth, host, exclusive, logError, readPdfQuery, overviewPdfHtml } = ctx;
  if (typeof exclusive !== 'function') throw new TypeError('core/routes/pdf.js: ctx.exclusive (the request queue) is missing.');

  app.get('/api/overview/pdf', auth, outsideQueue(async (req, res) => {
    const q = readPdfQuery(req.query);
    if (q.error) return res.status(400).json({ error: q.error });
    const { part, theme, range } = q;
    // Checked BEFORE the render, so bad requests never take one of the server's render slots.
    try {
      const html = await exclusive(() => overviewPdfHtml({ part, theme, range }));
      const pdf = await host.pdf.render(html, { part });
      res.setHeader('Content-Type', 'application/pdf');
      // The device's own date (core/local-date.js), the same name the Overview page gives the file.
      res.setHeader('Content-Disposition', `attachment; filename="${overviewPdfName(part)}"`);
      res.send(pdf);
    } catch (err) {
      if (!err.status || err.cause) logError('PDF generation failed:', err.cause || err); // a plain refusal ("busy") is not logged
      res.status(err.status || 500).json({ error: err.userMessage || 'Could not generate the PDF: ' + (err && err.message ? err.message : String(err)) });
    }
  }));
}
