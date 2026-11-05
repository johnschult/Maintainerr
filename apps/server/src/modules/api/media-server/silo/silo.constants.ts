/**
 * Silo adapter constants.
 */

/** Cache TTLs in seconds, matching the Emby adapter where the data is alike. */
export const SILO_CACHE_TTL = {
  METADATA: 300,
  /** A library listing, so offset pages of one walk agree with each other. */
  LISTING: 300,
  USERS: 1800,
  LIBRARIES: 1800,
  STATUS: 60,
} as const;

export const SILO_CACHE_KEYS = {
  METADATA: 'silo:metadata',
  METADATA_BATCH: 'silo:metadata-batch',
  CATALOG_ROW: 'silo:catalog-row',
  CHILDREN: 'silo:children',
  SEASONS: 'silo:seasons',
  USERS: 'silo:users',
  LIBRARIES: 'silo:libraries',
  STATUS: 'silo:status',
  LISTING: 'silo:listing',
  LIBRARY_ITEMS: 'silo:library-items',
} as const;

export const SILO_LIMITS = {
  /** `limit` ceiling on every paginated Silo route. */
  PAGE_SIZE: 200,
  /** `content_ids` ceiling on `GET /admin/catalog/items`. */
  CONTENT_IDS: 200,
  /** Results kept from one search. */
  SEARCH: 100,
  /** Single-item detail reads issued at once when a batch falls back. */
  DETAIL_CONCURRENCY: 5,
} as const;

/** Header that selects the profile a profile-scoped route answers as. */
export const SILO_PROFILE_HEADER = 'X-Profile-Id';
