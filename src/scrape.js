const { chromium } = require('playwright');

const PRODUCT_URL = 'https://us-store.msi.com/Motherboards/Intel-Platform-Motherboard/INTEL-Z890/MAG-Z890-TOMAHAWK-WIFI';

// The site's bot protection returns 403 "Access Denied" to Playwright's default
// headless shell. Full Chromium in new headless mode plus a regular (non-"HeadlessChrome")
// user agent gets through.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

async function main() {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ userAgent: USER_AGENT, locale: 'en-US' });
    const response = await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded' });
    if (!response || !response.ok()) {
      throw new Error(`Failed to load page: HTTP ${response && response.status()}`);
    }

    // Product title is an <h2 class="title">, not an <h1>
    const title = await page.locator('h2.title').first().textContent();
    console.log(title.trim());
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
