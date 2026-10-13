# MSI Product Scraper

A small Playwright scraper that extracts product data from the MSI US Store product page
[MAG Z890 TOMAHAWK WIFI](https://us-store.msi.com/Motherboards/Intel-Platform-Motherboard/INTEL-Z890/MAG-Z890-TOMAHAWK-WIFI)
and saves it as JSON.

## Requirements

- Node.js 20+ (required by Playwright)

## Usage

```bash
npm install
npx playwright install chromium
npm run scrape
```

The result is written to `output/product.json` (created or overwritten on every run).
A sample output is committed in this repository.

## Project structure

```
src/scrape.js        scraper: page loading, field extractors, normalization helpers
output/product.json  sample output
```

## Where each field comes from

The page has no JSON-LD or product microdata, so most fields are read from the DOM.

| Field | Source |
|---|---|
| `url` | Final page URL after navigation |
| `item_id` | `window.dataLayer` GA4 `view_item` event, `items[0].id` (e.g. `SKU_2373`) |
| `title` | `h2.title` |
| `brand` | `<title>` tag: the text before the product name (`"MSI MAG Z890 ..."` → `MSI`). There is no explicit brand field on the page |
| `product_category` | `category_tree` names joined with ` > ` |
| `category_tree` | `ol.breadcrumb li.breadcrumb-item`, excluding the site root ("Home") and the current product (the `active` item) |
| `description` | `.resellerKVContent__description .context` |
| `price`, `sale_price` | `#prices-new` inside `#prices-wrapper` (see notes below) |
| `availability` | Text of `#prices-wrapper` ("Out of stock", "In stock", "Pre-order") mapped to `in_stock` / `out_of_stock` / `pre_order` |
| `image_url` | `src` of `#imagePopup` |
| `additional_image_urls` | `popup_img` (full-size) attribute of gallery thumbnails in `#carouselImages` |
| `specs` | Rows (`th` → name, `td` → value) of the two spec tables in `.product-detail` |
| `star_rating`, `review_count` | `#average-rating-info` ("4.7 (3)") |
| `gtin` | Not available on the page, always `null` |
| `mpn` | "Manufacturer Number" row of the spec table |
| `scraped_at` | Current time, ISO 8601 |

## Normalization

- Prices are converted to numbers: `"$1,299.99"` → `1299.99`.
- Text is trimmed and whitespace collapsed; empty strings become `null`.
- Missing scalar fields are `null`, missing list fields are `[]`.
- Spec values keep their line breaks (`<br>` / list items) as `\n`; a `-` placeholder becomes `null`.
- Image URLs are de-duplicated and the main image is not repeated in `additional_image_urls`.

## Notes on the page

- **Bot protection.** The site answers Playwright's default headless shell with
  `403 Access Denied`. The scraper launches full Chromium in new headless mode
  (`channel: 'chromium'`) with a regular Chrome user agent, which loads the page normally.
  Both changes are needed; either one alone still gets 403.
- **Bundle options.** A dropdown lets the buyer add a bundle (e.g. a 2TB SSD for +$319.00),
  which changes the displayed price. `price` is always the price of the product alone:
  if a bundle option is selected, its surcharge is subtracted.
- **Sale price.** The product is not discounted at the moment, so `sale_price` is `null`.
  When the store shows a struck-through old price next to the current one, the old price
  goes to `price` and the current one to `sale_price`.
- **Rating** is loaded by a separate AJAX request (`product/review`) a moment after the page
  loads, so the scraper waits for it. If it does not appear (no reviews), both rating fields are `null`.
- **Description.** The `<meta name="description">` tag on this page describes a different product
  (Z890 GAMING PLUS WIFI), so the description is taken from the page content instead.
- **Gallery.** The carousel (Swiper) clones slides for its infinite loop; clones
  (`.swiper-slide-duplicate`) are skipped so images keep their gallery order.
