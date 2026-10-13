const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PRODUCT_URL = 'https://us-store.msi.com/Motherboards/Intel-Platform-Motherboard/INTEL-Z890/MAG-Z890-TOMAHAWK-WIFI';
const OUTPUT_FILE = path.join(__dirname, '..', 'output', 'product.json');

// The site's bot protection returns 403 "Access Denied" to Playwright's default
// headless shell. Full Chromium in new headless mode plus a regular (non-"HeadlessChrome")
// user agent gets through.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

// ---------- Normalization helpers ----------

// Collapses whitespace; empty or missing text becomes null
function cleanText(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

// "$1,299.99" -> 1299.99; anything without a number -> null
function parsePrice(text) {
  if (!text) return null;
  const match = text.replace(/,/g, '').match(/\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

// Maps the stock text shown under the price to one of the schema values
function parseAvailability(text) {
  const t = (text || '').toLowerCase();
  if (/out of stock|sold out/.test(t)) return 'out_of_stock';
  if (/pre-?order/.test(t)) return 'pre_order';
  if (/in stock/.test(t)) return 'in_stock';
  return null;
}

// ---------- Page helpers ----------

// Text of the first matching element, or null if it is not on the page
async function getText(page, selector) {
  const locator = page.locator(selector).first();
  if ((await locator.count()) === 0) return null;
  return cleanText(await locator.textContent());
}

async function getAttribute(page, selector, name) {
  const locator = page.locator(selector).first();
  if ((await locator.count()) === 0) return null;
  return cleanText(await locator.getAttribute(name));
}

// ---------- Field extractors ----------

// The bundle dropdown ("Motherboard Only / Without Bundle (+$0.00)",
// "... 2TB SSD (+$319.00)") changes the displayed price. On page load nothing
// is selected ("--- Please Select ---") and the price is the base one; a selected
// option gets the "active" class. Returns the total surcharge of selected options.
async function extractBundleSurcharge(page) {
  const selected = await page.locator('.product-dropdown .dropdown-item.active').allTextContents();
  return selected.reduce((sum, text) => {
    const match = text.match(/\(\+\$([\d,.]+)\)/);
    return sum + (match ? parsePrice(match[1]) : 0);
  }, 0);
}

// Removes the bundle surcharge so the price is for the product alone
function withoutSurcharge(price, surcharge) {
  if (price === null) return null;
  return Math.round((price - surcharge) * 100) / 100;
}

// Prices live in #prices-wrapper. When the product is on sale the store also
// shows a struck-through old price (".price-old" in other product cards), so the
// old one is the regular price and the new one is the sale price.
async function extractPrices(page) {
  const surcharge = await extractBundleSurcharge(page);
  const current = withoutSurcharge(parsePrice(await getText(page, '#prices-new')), surcharge);
  const old = withoutSurcharge(parsePrice(await getText(page, '#prices-wrapper [class*="old"]')), surcharge);

  if (old !== null && current !== null && old > current) {
    return { price: old, sale_price: current };
  }
  return { price: current, sale_price: null };
}

// The stock label is a class-less <span> next to the price, so read the
// whole price block text instead of targeting the span itself.
async function extractAvailability(page) {
  return parseAvailability(await getText(page, '#prices-wrapper'));
}

// There is no explicit brand field on the page. The <title> tag is
// "MSI MAG Z890 TOMAHAWK WIFI ATX Motherboard - ...", so the brand is
// whatever precedes the product name.
async function extractBrand(page, title) {
  if (!title) return null;
  const docTitle = await page.title();
  const index = docTitle.indexOf(title);
  return index > 0 ? cleanText(docTitle.slice(0, index)) : null;
}

// Breadcrumbs: "Home > Motherboards > INTEL PLATFORM > Intel Z890 > <product>".
// The category path is everything between "Home" (link to the site root) and
// the current product (the last, "active" item without a link).
async function extractCategoryTree(page) {
  const items = await page.locator('ol.breadcrumb li.breadcrumb-item:not(.active)').evaluateAll((lis) =>
    lis.map((li) => {
      const link = li.querySelector('a');
      return { name: li.textContent, url: link ? link.href : null };
    })
  );

  return items
    .map((item) => ({ name: cleanText(item.name), url: item.url }))
    .filter((item) => item.name && !isSiteRoot(item.url));
}

function isSiteRoot(url) {
  return url !== null && new URL(url).pathname === '/';
}

// Spec cells keep line breaks (<br>, <li>) as separate lines; "-" means "not available"
function cleanSpecValue(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split('\n').map(cleanText).filter(Boolean);
  const value = lines.join('\n');
  return value && value !== '-' ? value : null;
}

// Specs are two side-by-side tables in .product-detail, each row is
// <th scope="row">Name</th><td>Value</td>.
async function extractSpecs(page) {
  const rows = await page.locator('.product-detail table tr').evaluateAll((trs) =>
    trs.map((tr) => ({
      // textContent keeps the original case (the <th> is uppercased with CSS only),
      // innerText turns <br> and <li> into line breaks
      name: tr.querySelector('th')?.textContent,
      value: tr.querySelector('td')?.innerText,
    }))
  );

  return rows
    .map((row) => ({ name: cleanText(row.name), value: cleanSpecValue(row.value) }))
    .filter((spec) => spec.name);
}

function findSpec(specs, name) {
  const spec = specs.find((s) => s.name.toLowerCase() === name.toLowerCase());
  return spec ? spec.value : null;
}

// The page pushes a GA4 "view_item" event into window.dataLayer with the
// product SKU id (e.g. "SKU_2373").
async function extractItemId(page) {
  return page.evaluate(() => {
    const events = window.dataLayer || [];
    const viewItem = events.find((e) => e && e[0] === 'event' && e[1] === 'view_item');
    const item = viewItem && viewItem[2] && viewItem[2].items && viewItem[2].items[0];
    return item && item.id ? String(item.id) : null;
  });
}

// ---------- Main ----------

async function scrapeProduct(page) {
  const response = await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded' });
  if (!response || !response.ok()) {
    throw new Error(`Failed to load page: HTTP ${response && response.status()}`);
  }
  await page.waitForSelector('#prices-new');

  // Product title is an <h2 class="title">, not an <h1>
  const title = await getText(page, 'h2.title');
  const { price, sale_price } = await extractPrices(page);
  const categoryTree = await extractCategoryTree(page);
  const specs = await extractSpecs(page);

  return {
    url: page.url(),
    item_id: await extractItemId(page),
    title,
    brand: await extractBrand(page, title),
    product_category: categoryTree.map((item) => item.name).join(' > ') || null,
    category_tree: categoryTree,
    description: null, // TODO
    price,
    sale_price,
    availability: await extractAvailability(page),
    image_url: await getAttribute(page, '#imagePopup', 'src'),
    additional_image_urls: [], // TODO
    specs,
    star_rating: null, // TODO
    review_count: null, // TODO
    gtin: null, // TODO
    mpn: findSpec(specs, 'Manufacturer Number'),
    scraped_at: new Date().toISOString(),
  };
}

function saveJson(data, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

async function main() {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ userAgent: USER_AGENT, locale: 'en-US' });
    const product = await scrapeProduct(page);
    saveJson(product, OUTPUT_FILE);
    console.log(`Saved ${OUTPUT_FILE}`);
    console.log(product);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
