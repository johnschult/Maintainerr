import {
  type MediaActor,
  type MediaGenre,
  type MediaItem,
  type MediaItemType,
  type MediaLibrary,
  type MediaProviderIds,
  type MediaRating,
  type MediaServerStatus,
  type MediaSource,
  type MediaUser,
} from '@maintainerr/contracts';
import { addProviderId, emptyProviderIds } from '../media-provider-ids.utils';
import type {
  SiloAccountProfile,
  SiloAdminCatalogItem,
  SiloAdminCatalogVersion,
  SiloAdminUser,
  SiloCastCredit,
  SiloCatalogItemDetail,
  SiloCatalogItemType,
  SiloCatalogRating,
  SiloFileVersion,
  SiloLibrary,
  SiloSeason,
} from './silo.types';

/** The ids of the items around a Silo item, resolved by the adapter. */
export interface SiloItemContext {
  libraryId?: string;
  /** An episode's season, which Silo answers by number rather than id. */
  seasonId?: string;
  seasonTitle?: string;
  /**
   * A show's seasons on the server. Silo's own `season_count` follows the
   * metadata provider and counts seasons that have no files.
   */
  seasonCount?: number;
}

interface SiloProviderIdFields {
  imdb_id?: string | null;
  tmdb_id?: string | null;
  tvdb_id?: string | null;
}

const KBPS_TO_BPS = 1000;

export class SiloMapper {
  /**
   * Undefined for kinds Maintainerr does not manage (audiobooks, manga, ...),
   * so they are dropped instead of entering rule matching as movies.
   */
  static toMediaItemType(type?: string | null): MediaItemType | undefined {
    switch (type) {
      case 'movie':
        return 'movie';
      case 'series':
        return 'show';
      case 'season':
        return 'season';
      case 'episode':
        return 'episode';
      default:
        return undefined;
    }
  }

  /** The admin catalog filter for a kind. Seasons are not listed there. */
  static toCatalogItemType(
    type: MediaItemType,
  ): SiloCatalogItemType | undefined {
    switch (type) {
      case 'movie':
        return 'movie';
      case 'show':
        return 'series';
      case 'episode':
        return 'episode';
      default:
        return undefined;
    }
  }

  /** Undefined for library kinds other than movies and series. */
  static toLibraryType(type?: string | null): 'movie' | 'show' | undefined {
    switch (type) {
      case 'movies':
        return 'movie';
      case 'series':
        return 'show';
      default:
        return undefined;
    }
  }

  static extractProviderIds(fields: SiloProviderIdFields): MediaProviderIds {
    const providerIds = emptyProviderIds();
    addProviderId(providerIds, 'imdb', fields.imdb_id);
    addProviderId(providerIds, 'tmdb', fields.tmdb_id);
    addProviderId(providerIds, 'tvdb', fields.tvdb_id);
    return providerIds;
  }

  static toMediaLibrary(library: SiloLibrary): MediaLibrary | undefined {
    const type = SiloMapper.toLibraryType(library.type);
    if (!type) return undefined;

    return { id: library.id, title: library.name, type, agent: undefined };
  }

  /**
   * Maintainerr users are Silo profiles. Profile names repeat across
   * accounts, so the account name is kept beside it.
   */
  static toMediaUser(
    profile: SiloAccountProfile,
    account: SiloAdminUser,
  ): MediaUser {
    return {
      id: profile.id,
      name: `${profile.name} (${account.username})`,
      thumb: profile.avatar_url || undefined,
    };
  }

  static toMediaServerStatus(
    serverId: string,
    version: string,
    url?: string,
  ): MediaServerStatus {
    return {
      machineId: serverId,
      version,
      name: undefined,
      platform: undefined,
      url: url || undefined,
    };
  }

  /**
   * An admin catalog row: the listing every library read is built from.
   * Carries ids, sizes and dates but no genres, ratings or people.
   */
  static fromCatalogRow(
    row: SiloAdminCatalogItem,
    context: SiloItemContext = {},
  ): MediaItem | undefined {
    const type = SiloMapper.toMediaItemType(row.type);
    if (!type) return undefined;

    const isEpisode = type === 'episode';
    const parentId = isEpisode ? context.seasonId : undefined;
    const grandparentId = isEpisode ? row.series_id : undefined;

    return {
      id: row.content_id,
      guid: row.content_id,
      title: row.title,
      type,
      addedAt: new Date(row.added_at),
      providerIds: SiloMapper.extractProviderIds(row),
      mediaSources: (row.versions ?? []).map(SiloMapper.fromCatalogVersion),
      library: {
        id: context.libraryId ?? row.library_ids?.[0] ?? '',
        title: '',
      },
      parentId,
      parentGuid: parentId,
      parentTitle: isEpisode ? context.seasonTitle : undefined,
      grandparentId,
      grandparentGuid: grandparentId,
      grandparentTitle: isEpisode ? row.series_title : undefined,
      year: row.year ?? undefined,
      index: isEpisode ? row.episode_number : undefined,
      parentIndex: isEpisode ? row.season_number : undefined,
    };
  }

  /**
   * A full item read. Silo leaves `added_at` and the library off most detail
   * responses, so both come from the matching admin catalog row (for a season,
   * its series' row).
   */
  static fromDetail(
    detail: SiloCatalogItemDetail,
    row: SiloAdminCatalogItem | undefined,
    context: SiloItemContext = {},
  ): MediaItem | undefined {
    const type = SiloMapper.toMediaItemType(detail.type);
    if (!type) return undefined;

    const seriesId = detail.series_id || undefined;
    let parentId: string | undefined;
    let grandparentId: string | undefined;
    let parentTitle: string | undefined;
    let grandparentTitle: string | undefined;
    if (type === 'season') {
      parentId = seriesId;
      parentTitle = detail.series_title || undefined;
    } else if (type === 'episode') {
      parentId = context.seasonId;
      parentTitle = context.seasonTitle;
      grandparentId = seriesId;
      grandparentTitle = detail.series_title || undefined;
    }

    const addedAt = detail.added_at ?? row?.added_at;
    const durationSeconds =
      detail.duration_seconds ??
      detail.versions?.[0]?.duration ??
      (detail.runtime ? detail.runtime * 60 : undefined);
    const airDate =
      detail.release_date || detail.air_date || detail.first_air_date;
    const studios = detail.studios?.length ? detail.studios : detail.networks;

    return {
      id: detail.content_id,
      guid: detail.content_id,
      title: detail.title,
      type,
      addedAt: new Date(addedAt ?? ''),
      providerIds: SiloMapper.extractProviderIds(detail),
      mediaSources: (detail.versions ?? []).map(SiloMapper.fromFileVersion),
      path: detail.versions?.[0]?.file_path || undefined,
      library: {
        id: context.libraryId ?? row?.library_ids?.[0] ?? '',
        title: '',
      },
      parentId,
      parentGuid: parentId,
      parentTitle,
      grandparentId,
      grandparentGuid: grandparentId,
      grandparentTitle,
      summary: detail.overview || undefined,
      year: detail.year ?? undefined,
      durationMs: durationSeconds ? durationSeconds * 1000 : undefined,
      originallyAvailableAt: airDate ? new Date(airDate) : undefined,
      contentRating: detail.content_rating || undefined,
      ratings: (detail.ratings ?? []).map(SiloMapper.toMediaRating),
      genres: SiloMapper.toMediaGenres(detail.genres),
      actors: (detail.cast ?? []).map(SiloMapper.toMediaActor),
      studios: studios?.length ? studios : undefined,
      childCount:
        type === 'show'
          ? context.seasonCount
          : type === 'season'
            ? (detail.episode_count ?? undefined)
            : undefined,
      index:
        type === 'season'
          ? (detail.season_number ?? undefined)
          : type === 'episode'
            ? (detail.episode_number ?? undefined)
            : undefined,
      parentIndex:
        type === 'episode' ? (detail.season_number ?? undefined) : undefined,
    };
  }

  /**
   * A season from its series' season list. Silo keeps no added date on a
   * season, so it takes its series'.
   */
  static fromSeason(
    season: SiloSeason,
    series: SiloAdminCatalogItem,
    context: SiloItemContext = {},
  ): MediaItem {
    return {
      id: season.content_id,
      guid: season.content_id,
      title: season.title,
      type: 'season',
      addedAt: new Date(series.added_at),
      providerIds: emptyProviderIds(),
      mediaSources: [],
      library: {
        id: context.libraryId ?? series.library_ids?.[0] ?? '',
        title: '',
      },
      parentId: series.content_id,
      parentGuid: series.content_id,
      parentTitle: series.title,
      summary: season.overview || undefined,
      originallyAvailableAt: season.air_date
        ? new Date(season.air_date)
        : undefined,
      childCount: season.episode_count,
      index: season.season_number,
    };
  }

  private static fromCatalogVersion(
    version: SiloAdminCatalogVersion,
  ): MediaSource {
    return {
      id: version.file_id,
      duration: 0,
      bitrate: version.bitrate_kbps
        ? version.bitrate_kbps * KBPS_TO_BPS
        : undefined,
      audioChannels: version.audio_channels || undefined,
      audioCodec: version.codec_audio || undefined,
      videoCodec: version.codec_video || undefined,
      videoResolution: version.resolution || undefined,
      container: version.container || undefined,
      sizeBytes: version.file_size || undefined,
    };
  }

  private static fromFileVersion(version: SiloFileVersion): MediaSource {
    return {
      id: version.file_id,
      duration: version.duration ? version.duration * 1000 : 0,
      bitrate: version.bitrate ? version.bitrate * KBPS_TO_BPS : undefined,
      audioCodec: version.codec_audio || undefined,
      videoCodec: version.codec_video || undefined,
      videoResolution: version.resolution || undefined,
      container: version.container || undefined,
      sizeBytes: version.file_size || undefined,
    };
  }

  /** Silo scores every source 0-100; Maintainerr ratings are 0-10. */
  private static toMediaRating(rating: SiloCatalogRating): MediaRating {
    return {
      source: rating.source,
      value: rating.score / 10,
      type: rating.source.includes('critic') ? 'critic' : 'audience',
    };
  }

  private static toMediaActor(credit: SiloCastCredit): MediaActor {
    return {
      id: credit.person_id || undefined,
      name: credit.name,
      role: credit.character || undefined,
      thumb: credit.photo_url || undefined,
    };
  }

  /** Genre ids are a stable hash of the name, as in the Emby mapper. */
  private static toMediaGenres(genres?: string[] | null): MediaGenre[] {
    return (genres ?? []).map((name) => ({
      id: SiloMapper.hashString(name),
      name,
    }));
  }

  private static hashString(value: string): number {
    let hash = 5381;
    for (let i = 0; i < value.length; i++) {
      hash = (hash * 33) ^ value.charCodeAt(i);
    }
    return hash >>> 0;
  }
}
