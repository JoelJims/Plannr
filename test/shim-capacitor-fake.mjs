// Stand-ins for @capacitor/core and @capgo/capacitor-pdf-generator, used ONLY by the PDF route of
// public/local-api.js in the phone-code test pass (test/shim-target.js redirects those two imports
// here). In the app, the plugin hands the PDF page to the Android WebView's print adapter. Here it
// records the page instead, so tests can check the phone's own PDF HTML, and answers with a tiny
// stand-in PDF. Nothing else in the phone code sees these.
export const Capacitor = {
  isNativePlatform: () => true,
  isPluginAvailable: (name) => name === 'PdfGenerator',
  getPlatform: () => 'android',
};

export const pdfRequests = [];
export const PdfGenerator = {
  async fromData(options) {
    pdfRequests.push(options);
    return { type: 'base64', base64: Buffer.from('%PDF-1.4 test stand-in').toString('base64') };
  },
};
