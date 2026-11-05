/**
 * Silo `/api/v2` response shapes, limited to the fields the adapter reads.
 * Source: Silo's committed OpenAPI spec (`contracts/api/v2/openapi.json`),
 * checked against a live server. Fields the spec marks optional or nullable
 * are typed that way; content and account ids are opaque strings.
 */

/** Cursor pagination. `page` is absent on bounded, unpaginated lists. */
export interface SiloPageInfo {
  has_more: boolean;
  next_cursor?: string;
}

export interface SiloCollection<T> {
  items: T[];
  page?: SiloPageInfo | null;
}

/** `GET /system/info` (public). `server_version` is opaque, never compared. */
export interface SiloSystemInfo {
  server_version: string;
  api_major: number;
}

/** `GET /system/identity` (public). */
export interface SiloServerIdentity {
  server_id: string;
}

/** `GET /account/me`: the account that owns the API key. */
export interface SiloAccount {
  id: string;
  username: string;
  role: string;
}

/** `GET /admin/users` */
export interface SiloAdminUser {
  id: string;
  username: string;
  role: string;
  enabled: boolean;
}

/** `GET /admin/users/{id}/profiles` */
export interface SiloAccountProfile {
  id: string;
  name: string;
  is_primary: boolean;
  avatar_url?: string;
}

/**
 * `GET /libraries`. `type` is free-form until Silo ratifies its vocabulary:
 * movies, series, mixed, audiobooks, ebooks, podcasts, manga.
 */
export interface SiloLibrary {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
}

export type SiloCatalogItemType = 'movie' | 'series' | 'episode';

/** A file version on an admin catalog row. `file_size` is in bytes. */
export interface SiloAdminCatalogVersion {
  file_id: string;
  library_id: string;
  file_size: number;
  bitrate_kbps?: number;
  audio_channels?: number;
  codec_audio?: string;
  codec_video?: string;
  container?: string;
  resolution?: string;
}

/**
 * `GET /admin/catalog/items`. Seasons are not listed here: they only exist
 * on the profile-scoped series routes.
 */
export interface SiloAdminCatalogItem {
  content_id: string;
  type: SiloCatalogItemType;
  title: string;
  added_at: string;
  library_ids: string[];
  versions: SiloAdminCatalogVersion[];
  year?: number | null;
  imdb_id?: string | null;
  tmdb_id?: string | null;
  tvdb_id?: string | null;
  series_id?: string;
  series_title?: string;
  season_number?: number;
  episode_number?: number;
}

/** A file version on an item detail. `bitrate` is kbps, `duration` seconds. */
export interface SiloFileVersion {
  file_id: string;
  file_size: number;
  bitrate: number;
  duration: number;
  codec_audio: string;
  codec_video: string;
  container: string;
  resolution: string;
  file_path?: string;
}

/** `score` is on a 0-100 scale; `display` is the source's own scale. */
export interface SiloCatalogRating {
  source: string;
  name: string;
  score: number;
}

export interface SiloCastCredit {
  name: string;
  character: string;
  person_id?: string;
  photo_url?: string;
}

/**
 * `GET /catalog/items/{id}` (profile scoped). Carries no library id and no
 * `added_at` for most kinds, so the adapter joins it with the admin catalog
 * row. Per-profile fields (`user_data`, `user_state`) belong to the profile
 * Maintainerr reads as and are deliberately not typed here.
 */
export interface SiloCatalogItemDetail {
  content_id: string;
  title: string;
  type: string;
  genres: string[];
  cast: SiloCastCredit[];
  ratings: SiloCatalogRating[];
  versions: SiloFileVersion[];
  added_at?: string | null;
  year?: number | null;
  release_date?: string | null;
  first_air_date?: string | null;
  air_date?: string | null;
  overview?: string | null;
  content_rating?: string | null;
  runtime?: number | null;
  duration_seconds?: number | null;
  studios?: string[] | null;
  networks?: string[] | null;
  imdb_id?: string | null;
  tmdb_id?: string | null;
  tvdb_id?: string | null;
  series_id?: string | null;
  series_title?: string | null;
  season_number?: number | null;
  episode_number?: number | null;
  episode_count?: number | null;
}

/** `GET /catalog/series/{id}/seasons` (profile scoped). */
export interface SiloSeason {
  content_id: string;
  season_number: number;
  title: string;
  episode_count: number;
  air_date?: string | null;
  overview?: string | null;
}

/** `GET /catalog/items/{seasonId}/episodes` (profile scoped). */
export interface SiloEpisode {
  content_id: string;
  season_number: number;
  episode_number: number;
  title: string;
  runtime: number;
  air_date?: string | null;
  overview?: string | null;
  imdb_id?: string | null;
  tmdb_id?: string | null;
  tvdb_id?: string | null;
}

/** A row of `GET /catalog` (profile scoped browse and search). */
export interface SiloCatalogBrowseItem {
  content_id: string;
  type: string;
}
