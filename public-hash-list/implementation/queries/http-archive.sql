-- HTTP Archive BigQuery query for the Public Hash List.
--
-- Identifies web resources (scripts, CSS, fonts, WASM) whose SHA-256 body hash
-- appears across ≥100 independent origins in the HTTP Archive monthly crawl.
-- The ≥100-origins threshold is the k-anonymity privacy gate: a resource that
-- widespread cannot serve as a cross-site identifier.
--
-- Traffic-weighted score: each hash is scored by SUM(100000 / min_rank) across
-- origins, where min_rank is the CrUX popularity bucket of the hosting page
-- (1 000 = top 1K sites → 100 pts; 1 000 000 = top 1M → 0.1 pt). This lifts
-- hashes carried by high-traffic pages to the top of the list.
--
-- Run monthly in BigQuery against the httparchive.crawl.requests table.
-- Results are published directly by the HTTP Archive, fetched by http-archive.js:
--   https://cdn.httparchive.org/v1/static/reports/public_hash_list.csv

WITH request_origins AS (
  SELECT
    SAFE.STRING(payload._body_hash) AS body_hash, -- SHA-256 hash from WPT payload
    type,
    NET.HOST(url) AS origin,                       -- origin hosting the resource
    MIN(rank) AS min_rank,                         -- the most popular page rank bucket
    ANY_VALUE(url) AS sample_url
  FROM httparchive.crawl.requests
  WHERE
    date = DATE_TRUNC(CURRENT_DATE(), MONTH)
    AND SAFE.STRING(payload._body_hash) IS NOT NULL
    AND type IN ('script', 'css', 'font', 'wasm')
    AND SAFE.STRING(summary.method) = 'GET'
  GROUP BY
    body_hash,
    type,
    origin
),

hash_popularity AS (
  SELECT
    body_hash,
    type,
    COUNT(DISTINCT origin) AS num_origins,
    SUM(100000.0 / min_rank) AS traffic_weighted_score, -- top 1K website gets 100 points; top 1M gets 0.1 point
    ANY_VALUE(sample_url) AS sample_url
  FROM request_origins
  GROUP BY
    body_hash,
    type
)

SELECT
  body_hash,
  type,
  num_origins,
  traffic_weighted_score,
  sample_url
FROM hash_popularity
WHERE
  num_origins >= 100 -- privacy threshold (k-anonymity gate)
ORDER BY
  traffic_weighted_score DESC
