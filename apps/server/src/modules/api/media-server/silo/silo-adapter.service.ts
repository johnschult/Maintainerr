import {
  MediaServerFeature,
  MediaServerType,
  type CollectionVisibilitySettings,
  type CreateCollectionParams,
  type LibraryQueryOptions,
  type MediaCollection,
  type MediaItem,
  type MediaItemType,
  type MediaLibrary,
  type MediaPlaylist,
  type MediaServerStatus,
  type MediaUser,
  type PagedResult,
  type RecentlyAddedOptions,
  type UpdateCollectionParams,
  type WatchRecord,
} from '@maintainerr/contracts';
import { Injectable } from '@nestjs/common';
import {
  type AxiosInstance,
  type AxiosRequestConfig,
  isAxiosError,
} from 'axios';
import { chunk } from 'lodash';
import { formatConnectionFailureMessage } from '../../../../utils/connection-error';
import { MaintainerrLogger } from '../../../logging/logs.service';
import { SettingsDataService } from '../../../settings/settings-data.service';
import cacheManager, { type Cache } from '../../lib/cache';
import { SiloApi } from '../../silo-api/silo-api.helper';
import { resolveContextActionIds } from '../context-action.util';
import { supportsFeature } from '../media-server.constants';
import type {
  CollectionMutationOutcome,
  IMediaServerService,
  MediaWatchState,
} from '../media-server.interface';
import { readMetadataInBatches } from '../metadata-batch.util';
import {
  SILO_CACHE_KEYS,
  SILO_CACHE_TTL,
  SILO_LIMITS,
  SILO_PROFILE_HEADER,
} from './silo.constants';
import { SiloMapper, type SiloItemContext } from './silo.mapper';
import type {
  SiloAccount,
  SiloAccountProfile,
  SiloAdminCatalogItem,
  SiloAdminUser,
  SiloCatalogBrowseItem,
  SiloCatalogItemDetail,
  SiloCatalogItemType,
  SiloCollection,
  SiloEpisode,
  SiloLibrary,
  SiloSeason,
  SiloServerIdentity,
  SiloSystemInfo,
} from './silo.types';

interface SiloStatusSnapshot {
  info: SiloSystemInfo;
  identity: SiloServerIdentity;
}

/**
 * Silo media server adapter.
 *
 * Implements IMediaServerService against Silo's native API (`/api/v2`,
 * https://siloserver.org). Silo differs from the other servers in ways that
 * shape this adapter:
 * - Admin listings are cursor paginated in content id order, with no sort and
 *   no total. Library reads therefore walk the whole listing once, hold it
 *   briefly, and page and sort it in memory.
 * - Rich item reads (detail, seasons, episodes, search) are profile scoped.
 *   They are read as the primary profile of the account that owns the API
 *   key. Per-profile fields on those reads (played state, progress) are never
 *   used; watch data comes from Silo's server-wide playback history.
 * - Silo never deletes media files, by design.
 *
 * Collections, watch history, sessions, refresh and scan are not implemented
 * yet and throw, so no caller mistakes them for an empty answer.
 */
@Injectable()
export class SiloAdapterService implements IMediaServerService {
  private http: AxiosInstance | undefined;
  private initialized = false;
  private siloUrl: string | undefined;
  private profileId: string | undefined;
  private readonly cache: Cache;
  // Whole-library listings. Held by reference (no cloning) because a library
  // is paged through many times per run; never mutate a value read from it.
  private readonly listings: Cache;
  // Shared in-flight metadata reads, keyed by item id. See getMetadata.
  private readonly metadataRequests = new Map<
    string,
    Promise<MediaItem | undefined>
  >();

  constructor(
    private readonly settings: SettingsDataService,
    private readonly logger: MaintainerrLogger,
  ) {
    this.logger.setContext(SiloAdapterService.name);
    this.cache = cacheManager.getCache('silo');
    this.listings = cacheManager.getCache('silolibrary');
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async initialize(): Promise<void> {
    const url = this.settings.silo_url;
    const apiKey = this.settings.silo_api_key;

    if (!url || !apiKey) {
      this.logger.debug(
        'Silo settings incomplete - skipping initialize (url or api_key missing)',
      );
      this.initialized = false;
      this.http = undefined;
      return;
    }

    this.siloUrl = url;
    this.http = new SiloApi({ url, apiKey }).axios;

    try {
      const [info, profileId] = await Promise.all([
        this.http.get<SiloSystemInfo>('/system/info'),
        this.resolvePrimaryProfileId(this.http),
      ]);
      this.profileId = profileId;
      this.initialized = true;
      this.logger.log(
        `Silo connection established to ${url} (build ${info.data.server_version})`,
      );
    } catch (error) {
      this.initialized = false;
      this.logger.warn(
        `Failed to initialize Silo connection: ${formatConnectionFailureMessage(error, 'Connection failed')}`,
      );
    }
  }

  uninitialize(): void {
    this.http = undefined;
    this.initialized = false;
    this.siloUrl = undefined;
    this.profileId = undefined;
    this.metadataRequests.clear();
    this.cache.flush();
    this.listings.flush();
  }

  isSetup(): boolean {
    return this.initialized && this.http !== undefined;
  }

  getServerType(): MediaServerType {
    return MediaServerType.SILO;
  }

  supportsFeature(feature: MediaServerFeature): boolean {
    return supportsFeature(MediaServerType.SILO, feature);
  }

  // ============================================================================
  // Server / Users
  // ============================================================================

  async getStatus(): Promise<MediaServerStatus | undefined> {
    if (!this.http) return undefined;
    try {
      let status = this.cache.data.get<SiloStatusSnapshot>(
        SILO_CACHE_KEYS.STATUS,
      );
      if (!status) {
        const [info, identity] = await Promise.all([
          this.http.get<SiloSystemInfo>('/system/info'),
          this.http.get<SiloServerIdentity>('/system/identity'),
        ]);
        status = { info: info.data, identity: identity.data };
        this.cache.data.set(
          SILO_CACHE_KEYS.STATUS,
          status,
          SILO_CACHE_TTL.STATUS,
        );
      }
      return SiloMapper.toMediaServerStatus(
        status.identity.server_id,
        status.info.server_version,
        this.siloUrl,
      );
    } catch (error) {
      this.logger.debug(
        `Silo getStatus failed: ${formatConnectionFailureMessage(error, 'Connection failed')}`,
      );
      return undefined;
    }
  }

  /**
   * Every profile of every account. Watch history in Silo is per profile, so
   * profiles are what Maintainerr calls users.
   */
  async getUsers(throwOnError = false): Promise<MediaUser[]> {
    if (!this.http) {
      if (throwOnError) throw new Error('Silo API not initialized');
      return [];
    }

    const cached = this.cache.data.get<MediaUser[]>(SILO_CACHE_KEYS.USERS);
    if (cached !== undefined) return cached;

    try {
      const accounts = await this.readAllPages<SiloAdminUser>('/admin/users');
      const users: MediaUser[] = [];
      for (const batch of chunk(accounts, SILO_LIMITS.DETAIL_CONCURRENCY)) {
        const profiles = await Promise.all(
          batch.map((account) =>
            this.readBounded<SiloAccountProfile>(
              `/admin/users/${encodeURIComponent(account.id)}/profiles`,
            ),
          ),
        );
        batch.forEach((account, index) => {
          for (const profile of profiles[index]) {
            users.push(SiloMapper.toMediaUser(profile, account));
          }
        });
      }
      this.cache.data.set(SILO_CACHE_KEYS.USERS, users, SILO_CACHE_TTL.USERS);
      return users;
    } catch (error) {
      if (throwOnError) throw error;
      this.logger.debug(
        `Silo getUsers failed: ${formatConnectionFailureMessage(error, 'Connection failed')}`,
      );
      return [];
    }
  }

  async getUser(id: string): Promise<MediaUser | undefined> {
    return (await this.getUsers()).find((user) => user.id === id);
  }

  // ============================================================================
  // Libraries
  // ============================================================================

  async getLibraries(): Promise<MediaLibrary[]> {
    if (!this.http) return [];
    try {
      return await this.readLibraries();
    } catch (error) {
      this.logger.warn(
        `Silo getLibraries failed: ${formatConnectionFailureMessage(error, 'Connection failed')}`,
      );
      return [];
    }
  }

  async getLibrariesStorage(): Promise<Map<string, number>> {
    // Silo has no per-library size endpoint; computeLibraryStorageSizes sums
    // the file sizes the admin catalog already carries.
    return new Map();
  }

  async computeLibraryStorageSizes(): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (!this.http) return result;

    for (const library of await this.getLibraries()) {
      try {
        const rows = await this.readListing(
          library.id,
          library.type === 'movie' ? 'movie' : 'episode',
        );
        let total = 0;
        for (const row of rows) {
          for (const version of row.versions ?? []) {
            // A file shared by two libraries is counted under the one it is in.
            if (version.library_id === library.id) total += version.file_size;
          }
        }
        if (total > 0) result.set(library.id, total);
      } catch (error) {
        this.logger.debug(
          `Silo computeLibraryStorageSizes(${library.id}) failed: ${formatConnectionFailureMessage(error, 'Connection failed')}`,
        );
      }
    }
    return result;
  }

  async getLibraryContents(
    libraryId: string,
    options?: LibraryQueryOptions,
  ): Promise<PagedResult<MediaItem>> {
    if (!this.http) {
      throw new Error('Silo API not initialized');
    }

    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? SILO_LIMITS.PAGE_SIZE;

    try {
      const type = options?.type ?? (await this.libraryItemType(libraryId));
      const items = this.sortItems(
        await this.readLibraryItems(libraryId, type),
        options?.sort,
        options?.sortOrder,
      );
      return {
        items: items.slice(offset, offset + limit),
        totalSize: items.length,
        offset,
        limit,
      };
    } catch (error) {
      this.logger.warn(
        `Silo getLibraryContents(${libraryId}) failed: ${formatConnectionFailureMessage(error, 'Connection failed')}`,
      );
      throw error;
    }
  }

  async getLibraryContentCount(
    libraryId: string,
    type?: MediaItemType,
  ): Promise<number> {
    if (!this.http) {
      throw new Error('Silo API not initialized');
    }

    try {
      const itemType = type ?? (await this.libraryItemType(libraryId));
      return (await this.readLibraryItems(libraryId, itemType)).length;
    } catch (error) {
      this.logger.warn(
        `Silo getLibraryContentCount(${libraryId}) failed: ${formatConnectionFailureMessage(error, 'Connection failed')}`,
      );
      throw error;
    }
  }

  async searchLibraryContents(
    libraryId: string,
    query: string,
    type?: MediaItemType,
  ): Promise<MediaItem[]> {
    if (!this.http) return [];
    try {
      const kinds: MediaItemType[] = type ? [type] : ['movie', 'show'];
      const catalogType = type ? SiloMapper.toCatalogItemType(type) : undefined;
      if (type && !catalogType) return [];

      return await this.search(query, kinds, {
        library_id: libraryId,
        type: catalogType,
      });
    } catch (error) {
      this.logger.debug(
        `Silo searchLibraryContents failed: ${formatConnectionFailureMessage(error, 'Connection failed')}`,
      );
      return [];
    }
  }

  async searchContent(query: string): Promise<MediaItem[]> {
    if (!this.http) return [];
    try {
      return await this.search(query, ['movie', 'show', 'episode'], {
        type: 'video_with_episodes',
      });
    } catch (error) {
      this.logger.debug(
        `Silo searchContent failed: ${formatConnectionFailureMessage(error, 'Connection failed')}`,
      );
      return [];
    }
  }

  async getRecentlyAdded(
    libraryId: string,
    options?: RecentlyAddedOptions,
  ): Promise<MediaItem[]> {
    if (!this.http) return [];
    try {
      const libraryType = await this.libraryItemType(libraryId);
      const type =
        options?.type ?? (libraryType === 'movie' ? 'movie' : 'episode');
      const items = this.sortItems(
        await this.readLibraryItems(libraryId, type),
        'addedAt',
        'desc',
      );
      return items.slice(0, options?.limit ?? 20);
    } catch (error) {
      this.logger.debug(
        `Silo getRecentlyAdded(${libraryId}) failed: ${formatConnectionFailureMessage(error, 'Connection failed')}`,
      );
      return [];
    }
  }

  // ============================================================================
  // Metadata
  // ============================================================================

  /**
   * Cached and de-duplicated like the other adapters' (#3355): every rule
   * condition re-reads the evaluated item and its parents through here. Only a
   * resolved item is stored.
   */
  async getMetadata(itemId: string): Promise<MediaItem | undefined> {
    if (!this.http) return undefined;

    const cacheKey = `${SILO_CACHE_KEYS.METADATA}:${itemId}`;
    const cached = this.cache.data.get<MediaItem>(cacheKey);
    if (cached !== undefined) return cached;

    const inFlight = this.metadataRequests.get(itemId);
    if (inFlight !== undefined) return inFlight;

    const pending = this.fetchMetadata(itemId, cacheKey).finally(() => {
      this.metadataRequests.delete(itemId);
    });
    this.metadataRequests.set(itemId, pending);

    return pending;
  }

  /**
   * One admin catalog read per 200 ids. Seasons are not in that listing, so
   * any id it does not answer is read on its own.
   */
  async getMetadataBatch(itemIds: string[]): Promise<MediaItem[]> {
    if (!this.http) return [];

    const listed = await readMetadataInBatches({
      itemIds,
      // Each id is sent as its own `content_ids=` parameter.
      perIdCost: '&content_ids='.length,
      cache: {
        get: (itemId) =>
          this.cache.data.get<MediaItem>(
            `${SILO_CACHE_KEYS.METADATA_BATCH}:${itemId}`,
          ),
        set: (item) =>
          this.cache.data.set(
            `${SILO_CACHE_KEYS.METADATA_BATCH}:${item.id}`,
            item,
            SILO_CACHE_TTL.METADATA,
          ),
      },
      readBatch: async (idBatch) => {
        const rows = await this.readCatalogRows(idBatch);
        return this.mapCatalogRows([...rows.values()]);
      },
      onBatchError: (idBatch, error) => {
        this.logger.warn(
          `Failed to get metadata for ${idBatch.length} Silo item(s)`,
        );
        this.logger.debug(
          formatConnectionFailureMessage(error, 'Connection failed'),
        );
      },
    });

    const resolved = new Set(listed.map((item) => item.id));
    const unlisted = [...new Set(itemIds)].filter((id) => !resolved.has(id));
    for (const batch of chunk(unlisted, SILO_LIMITS.DETAIL_CONCURRENCY)) {
      for (const item of await Promise.all(
        batch.map((id) => this.getMetadata(id)),
      )) {
        if (item) listed.push(item);
      }
    }
    return listed;
  }

  /**
   * `false` only when Silo answers 404 for the item. Anything else is
   * inconclusive and throws, so a blip never reads as "deleted". Uses the
   * detail route because the admin listing has no seasons.
   */
  async itemExists(itemId: string): Promise<boolean> {
    if (!this.http) {
      throw new Error('Silo not initialized');
    }

    try {
      await this.readDetail(itemId);
      return true;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * A show's seasons or a season's episodes. A show asked for its episodes
   * answers every season's. With `throwOnError` a failed read throws instead
   * of answering an empty list, which a caller would read as "no children".
   */
  async getChildrenMetadata(
    parentId: string,
    childType?: MediaItemType,
    throwOnError = false,
  ): Promise<MediaItem[]> {
    if (!this.http) {
      if (throwOnError) throw new Error('Silo API not initialized');
      return [];
    }

    const cacheKey = `${SILO_CACHE_KEYS.CHILDREN}:${parentId}:${childType ?? 'any'}`;
    const cached = this.cache.data.get<MediaItem[]>(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const children = await this.readChildren(parentId, childType);
      this.cache.data.set(cacheKey, children, SILO_CACHE_TTL.METADATA);
      return children;
    } catch (error) {
      if (throwOnError) {
        throw new Error(
          `Could not read the children of Silo item ${parentId}`,
          {
            cause: error,
          },
        );
      }
      this.logger.debug(
        `Silo getChildrenMetadata(${parentId}) failed: ${formatConnectionFailureMessage(error, 'Connection failed')}`,
      );
      return [];
    }
  }

  async getAllIdsForContextAction(
    collectionType: MediaItemType | undefined,
    context: { type: MediaItemType; id: string },
    mediaId: string,
  ): Promise<string[]> {
    return resolveContextActionIds(
      collectionType,
      context,
      mediaId,
      (parentId, type) => this.getChildrenMetadata(parentId, type, true),
      (message) => this.logger.warn(message),
    );
  }

  // Item ids are ignored: besides the server-wide aggregates every entry is a
  // short-lived read, so a full flush is the simplest correct reset.
  resetMetadataCache(): void {
    this.cache.flush();
    this.listings.flush();
  }

  async getPlaylists(libraryId: string): Promise<MediaPlaylist[]> {
    this.logger.debug(`Silo has no library playlists (library ${libraryId})`);
    // Silo playlists are per profile and PLAYLISTS is not a supported feature.
    return [];
  }

  // ============================================================================
  // Not implemented yet. These throw rather than answer empty: an empty watch
  // history reads as "never watched", an empty session list as "nothing is
  // playing" and an empty collection as "no members", all of which can lead
  // to deletions.
  // ============================================================================

  async prefetchWatchHistory(options: { libraryId: string }): Promise<void> {
    this.notImplemented(`prefetchWatchHistory(${options.libraryId})`);
  }

  async getWatchHistory(itemId: string): Promise<WatchRecord[]> {
    this.notImplemented(`getWatchHistory(${itemId})`);
  }

  async getWatchState(itemId: string): Promise<MediaWatchState> {
    this.notImplemented(`getWatchState(${itemId})`);
  }

  async getItemSeenBy(itemId: string): Promise<string[]> {
    this.notImplemented(`getItemSeenBy(${itemId})`);
  }

  async getActiveSessions(): Promise<Set<string>> {
    this.notImplemented('getActiveSessions');
  }

  async getCollections(libraryId: string): Promise<MediaCollection[]> {
    this.notImplemented(`getCollections(${libraryId})`);
  }

  async getCollection(
    collectionId: string,
  ): Promise<MediaCollection | undefined> {
    this.notImplemented(`getCollection(${collectionId})`);
  }

  async createCollection(
    params: CreateCollectionParams,
  ): Promise<MediaCollection> {
    this.notImplemented(`createCollection(${params.title})`);
  }

  async deleteCollection(collectionId: string): Promise<void> {
    this.notImplemented(`deleteCollection(${collectionId})`);
  }

  async cleanupCollectionForLibrary(collectionId: string): Promise<void> {
    this.notImplemented(`cleanupCollectionForLibrary(${collectionId})`);
  }

  async getCollectionChildren(collectionId: string): Promise<MediaItem[]> {
    this.notImplemented(`getCollectionChildren(${collectionId})`);
  }

  async addToCollection(collectionId: string): Promise<void> {
    this.notImplemented(`addToCollection(${collectionId})`);
  }

  async addBatchToCollection(
    collectionId: string,
  ): Promise<CollectionMutationOutcome> {
    this.notImplemented(`addBatchToCollection(${collectionId})`);
  }

  async removeFromCollection(collectionId: string): Promise<void> {
    this.notImplemented(`removeFromCollection(${collectionId})`);
  }

  async removeBatchFromCollection(
    collectionId: string,
  ): Promise<CollectionMutationOutcome> {
    this.notImplemented(`removeBatchFromCollection(${collectionId})`);
  }

  async updateCollection(
    params: UpdateCollectionParams,
  ): Promise<MediaCollection> {
    this.notImplemented(`updateCollection(${params.collectionId})`);
  }

  async updateCollectionVisibility(
    settings: CollectionVisibilitySettings,
  ): Promise<void> {
    this.notImplemented(`updateCollectionVisibility(${settings.collectionId})`);
  }

  async reorderCollectionItems(collectionId: string): Promise<void> {
    this.notImplemented(`reorderCollectionItems(${collectionId})`);
  }

  async setCollectionImage(collectionId: string): Promise<void> {
    this.notImplemented(`setCollectionImage(${collectionId})`);
  }

  async refreshItemMetadata(itemId: string): Promise<void> {
    this.notImplemented(`refreshItemMetadata(${itemId})`);
  }

  async scanFolder(libraryId: string): Promise<void> {
    this.notImplemented(`scanFolder(${libraryId})`);
  }

  /**
   * Silo never deletes or moves media files, by design. Files are removed
   * through Radarr or Sonarr, whose delete webhooks Silo follows.
   */
  async deleteFromDisk(itemId: string): Promise<void> {
    throw new Error(
      `Silo does not delete media files (item ${itemId}). Handle this item through Radarr or Sonarr.`,
    );
  }

  // ============================================================================
  // Internal: reads
  // ============================================================================

  private notImplemented(operation: string): never {
    throw new Error(`Silo ${operation} is not implemented yet`);
  }

  private profileConfig(): AxiosRequestConfig {
    if (!this.profileId) {
      throw new Error('Silo has no profile to read as');
    }
    return { headers: { [SILO_PROFILE_HEADER]: this.profileId } };
  }

  private async resolvePrimaryProfileId(
    client: AxiosInstance,
    config?: AxiosRequestConfig,
  ): Promise<string> {
    const { data: account } = await client.get<SiloAccount>(
      '/account/me',
      config,
    );
    const { data } = await client.get<SiloCollection<SiloAccountProfile>>(
      `/admin/users/${encodeURIComponent(account.id)}/profiles`,
      config,
    );
    const primary = data?.items?.find((profile) => profile.is_primary);
    if (!primary) {
      throw new Error(
        `Silo account ${account.username} has no primary profile`,
      );
    }
    return primary.id;
  }

  /** A list Silo answers in one response. A paginated answer is an error. */
  private async readBounded<T>(
    path: string,
    config?: AxiosRequestConfig,
  ): Promise<T[]> {
    const { data } = await this.http.get<SiloCollection<T>>(path, config);
    if (!Array.isArray(data?.items)) {
      throw new Error(`Silo returned no item list for ${path}`);
    }
    if (data.page?.has_more) {
      throw new Error(`Silo paginated ${path}, which this adapter reads whole`);
    }
    return data.items;
  }

  /**
   * Every page of a cursor-paginated list. Throws on a malformed page or a
   * cursor that does not advance, so a partial walk never passes as complete.
   */
  private async readAllPages<T>(
    path: string,
    params: Record<string, unknown> = {},
    config: AxiosRequestConfig = {},
  ): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;

    for (;;) {
      const { data } = await this.http.get<SiloCollection<T>>(path, {
        ...config,
        params: { ...params, limit: SILO_LIMITS.PAGE_SIZE, cursor },
      });
      if (!Array.isArray(data?.items)) {
        throw new Error(`Silo returned no item list for ${path}`);
      }
      items.push(...data.items);

      if (!data.page?.has_more) return items;

      const next = data.page.next_cursor;
      if (!next || next === cursor) {
        throw new Error(`Silo pagination for ${path} made no progress`);
      }
      cursor = next;
    }
  }

  private async readLibraries(): Promise<MediaLibrary[]> {
    const cached = this.cache.data.get<MediaLibrary[]>(
      SILO_CACHE_KEYS.LIBRARIES,
    );
    if (cached !== undefined) return cached;

    const libraries: MediaLibrary[] = [];
    for (const library of await this.readBounded<SiloLibrary>('/libraries')) {
      const mapped = library.enabled
        ? SiloMapper.toMediaLibrary(library)
        : undefined;
      if (mapped) {
        libraries.push(mapped);
      } else {
        this.logger.debug(
          `Skipping Silo library ${library.id} (${library.type}${library.enabled ? '' : ', disabled'})`,
        );
      }
    }
    this.cache.data.set(
      SILO_CACHE_KEYS.LIBRARIES,
      libraries,
      SILO_CACHE_TTL.LIBRARIES,
    );
    return libraries;
  }

  /** What a library holds when a caller names no item type. */
  private async libraryItemType(libraryId: string): Promise<MediaItemType> {
    const library = (await this.readLibraries()).find(
      (candidate) => candidate.id === libraryId,
    );
    if (!library) {
      throw new Error(
        `Silo library ${libraryId} is not a movie or series library`,
      );
    }
    return library.type === 'movie' ? 'movie' : 'show';
  }

  /** The admin catalog rows of one kind in one library, cached briefly. */
  private async readListing(
    libraryId: string,
    type: SiloCatalogItemType,
  ): Promise<SiloAdminCatalogItem[]> {
    const key = `${SILO_CACHE_KEYS.LISTING}:${libraryId}:${type}`;
    const cached = this.listings.data.get<SiloAdminCatalogItem[]>(key);
    if (cached !== undefined) return cached;

    const rows = await this.readAllPages<SiloAdminCatalogItem>(
      '/admin/catalog/items',
      { library_id: libraryId, type },
    );
    this.listings.data.set(key, rows, SILO_CACHE_TTL.LISTING);
    return rows;
  }

  /**
   * Every item of a kind in a library, mapped once and cached with the
   * listing. Seasons are not in the admin catalog, so they come from each
   * series' season list.
   */
  private async readLibraryItems(
    libraryId: string,
    type: MediaItemType,
  ): Promise<MediaItem[]> {
    const key = `${SILO_CACHE_KEYS.LIBRARY_ITEMS}:${libraryId}:${type}`;
    const cached = this.listings.data.get<MediaItem[]>(key);
    if (cached !== undefined) return cached;

    let items: MediaItem[];
    if (type === 'season') {
      items = [];
      const series = await this.readListing(libraryId, 'series');
      for (const batch of chunk(series, SILO_LIMITS.DETAIL_CONCURRENCY)) {
        const seasons = await Promise.all(
          batch.map((row) => this.readSeasons(row.content_id)),
        );
        batch.forEach((row, index) => {
          for (const season of seasons[index]) {
            items.push(SiloMapper.fromSeason(season, row, { libraryId }));
          }
        });
      }
    } else {
      const catalogType = SiloMapper.toCatalogItemType(type);
      items = await this.mapCatalogRows(
        await this.readListing(libraryId, catalogType),
        libraryId,
      );
    }

    this.listings.data.set(key, items, SILO_CACHE_TTL.LISTING);
    return items;
  }

  /**
   * Admin catalog rows to items. Episodes name their season only by number,
   * so each series' season list is read to fill in the season id.
   */
  private async mapCatalogRows(
    rows: SiloAdminCatalogItem[],
    libraryId?: string,
  ): Promise<MediaItem[]> {
    const seriesIds = [
      ...new Set(
        rows
          .filter((row) => row.type === 'episode' && row.series_id)
          .map((row) => row.series_id),
      ),
    ];
    const seasonsBySeries = new Map<string, SiloSeason[]>();
    for (const batch of chunk(seriesIds, SILO_LIMITS.DETAIL_CONCURRENCY)) {
      const seasons = await Promise.all(
        batch.map((seriesId) => this.readSeasons(seriesId)),
      );
      batch.forEach((seriesId, index) =>
        seasonsBySeries.set(seriesId, seasons[index]),
      );
    }

    const items: MediaItem[] = [];
    for (const row of rows) {
      const context: SiloItemContext = { libraryId };
      if (row.type === 'episode' && row.series_id) {
        const season = seasonsBySeries
          .get(row.series_id)
          ?.find((candidate) => candidate.season_number === row.season_number);
        context.seasonId = season?.content_id;
        context.seasonTitle = season?.title;
      }
      const item = SiloMapper.fromCatalogRow(row, context);
      if (item) items.push(item);
    }
    return items;
  }

  /** Admin catalog rows by id. Ids Silo does not list are simply absent. */
  private async readCatalogRows(
    ids: string[],
  ): Promise<Map<string, SiloAdminCatalogItem>> {
    const rows = new Map<string, SiloAdminCatalogItem>();
    const toRead: string[] = [];
    for (const id of new Set(ids)) {
      const cached = this.cache.data.get<SiloAdminCatalogItem>(
        `${SILO_CACHE_KEYS.CATALOG_ROW}:${id}`,
      );
      if (cached === undefined) toRead.push(id);
      else rows.set(id, cached);
    }

    for (const batch of chunk(toRead, SILO_LIMITS.CONTENT_IDS)) {
      const requested = new Set(batch);
      const listed = await this.readAllPages<SiloAdminCatalogItem>(
        '/admin/catalog/items',
        { content_ids: batch },
      );
      for (const row of listed) {
        if (!requested.has(row.content_id)) continue;
        rows.set(row.content_id, row);
        this.cache.data.set(
          `${SILO_CACHE_KEYS.CATALOG_ROW}:${row.content_id}`,
          row,
          SILO_CACHE_TTL.METADATA,
        );
      }
    }
    return rows;
  }

  private async readSeasons(seriesId: string): Promise<SiloSeason[]> {
    const key = `${SILO_CACHE_KEYS.SEASONS}:${seriesId}`;
    const cached = this.cache.data.get<SiloSeason[]>(key);
    if (cached !== undefined) return cached;

    const seasons = await this.readBounded<SiloSeason>(
      `/catalog/series/${encodeURIComponent(seriesId)}/seasons`,
      { ...this.profileConfig(), params: { include_artwork: false } },
    );
    this.cache.data.set(key, seasons, SILO_CACHE_TTL.METADATA);
    return seasons;
  }

  private async readDetail(itemId: string): Promise<SiloCatalogItemDetail> {
    const { data } = await this.http.get<SiloCatalogItemDetail>(
      `/catalog/items/${encodeURIComponent(itemId)}`,
      this.profileConfig(),
    );
    return data;
  }

  private async fetchMetadata(
    itemId: string,
    cacheKey: string,
  ): Promise<MediaItem | undefined> {
    try {
      const detail = await this.readDetail(itemId);
      const type = SiloMapper.toMediaItemType(detail.type);
      if (!type) return undefined;

      // A season has no catalog row of its own; it is dated by its series.
      const rowId = type === 'season' ? detail.series_id : detail.content_id;
      const row = rowId
        ? (await this.readCatalogRows([rowId])).get(rowId)
        : undefined;
      if (!row) {
        this.logger.debug(
          `Silo getMetadata(${itemId}): no admin catalog row to date it by`,
        );
        return undefined;
      }

      const context: SiloItemContext = {};
      if (type === 'show') {
        context.seasonCount = (
          await this.readSeasons(detail.content_id)
        ).length;
      }
      if (type === 'episode' && detail.series_id) {
        const season = (await this.readSeasons(detail.series_id)).find(
          (candidate) => candidate.season_number === detail.season_number,
        );
        context.seasonId = season?.content_id;
        context.seasonTitle = season?.title;
      }

      const item = SiloMapper.fromDetail(detail, row, context);
      if (item) {
        this.cache.data.set(cacheKey, item, SILO_CACHE_TTL.METADATA);
      }
      return item;
    } catch (error) {
      this.logger.debug(
        `Silo getMetadata(${itemId}) failed: ${formatConnectionFailureMessage(error, 'Connection failed')}`,
      );
      return undefined;
    }
  }

  private async readChildren(
    parentId: string,
    childType?: MediaItemType,
  ): Promise<MediaItem[]> {
    const parentType =
      childType === 'season'
        ? 'show'
        : (await this.getMetadata(parentId))?.type;
    if (!parentType) {
      throw new Error(`Silo could not read item ${parentId}`);
    }

    if (parentType === 'show') {
      const series = (await this.readCatalogRows([parentId])).get(parentId);
      if (!series) {
        throw new Error(`Silo does not list series ${parentId}`);
      }
      const seasons = (await this.readSeasons(parentId)).map((season) =>
        SiloMapper.fromSeason(season, series),
      );
      if (childType !== 'episode') return seasons;

      const episodes: MediaItem[] = [];
      for (const season of seasons) {
        episodes.push(...(await this.readSeasonEpisodes(season.id)));
      }
      return episodes;
    }

    if (parentType === 'season' && childType !== 'season') {
      return this.readSeasonEpisodes(parentId);
    }

    return [];
  }

  /**
   * A season's episodes, dated and sized from their admin catalog rows. An
   * episode the catalog does not list fails the whole read, so a partial
   * season never passes as the full one.
   */
  private async readSeasonEpisodes(seasonId: string): Promise<MediaItem[]> {
    const episodes = await this.readBounded<SiloEpisode>(
      `/catalog/items/${encodeURIComponent(seasonId)}/episodes`,
      this.profileConfig(),
    );
    const rows = await this.readCatalogRows(
      episodes.map((episode) => episode.content_id),
    );
    const ordered: SiloAdminCatalogItem[] = [];
    for (const episode of episodes) {
      const row = rows.get(episode.content_id);
      if (!row) {
        throw new Error(
          `Silo does not list episode ${episode.content_id} of season ${seasonId}`,
        );
      }
      ordered.push(row);
    }
    return this.mapCatalogRows(ordered);
  }

  /**
   * Silo's catalog search, answered as full items in Silo's relevance order.
   * Kinds outside `kinds` are dropped.
   */
  private async search(
    query: string,
    kinds: MediaItemType[],
    params: Record<string, string | undefined>,
  ): Promise<MediaItem[]> {
    const { data } = await this.http.get<SiloCollection<SiloCatalogBrowseItem>>(
      '/catalog',
      {
        ...this.profileConfig(),
        params: {
          source: 'query',
          q: query,
          limit: SILO_LIMITS.SEARCH,
          ...params,
        },
      },
    );
    const ids = (data?.items ?? [])
      .filter((row) => {
        const type = SiloMapper.toMediaItemType(row.type);
        return type !== undefined && kinds.includes(type);
      })
      .map((row) => row.content_id);

    const byId = new Map(
      (await this.getMetadataBatch(ids)).map((item) => [item.id, item]),
    );
    return ids
      .map((id) => byId.get(id))
      .filter((item): item is MediaItem => item !== undefined);
  }

  /**
   * Sort a library in memory. Silo lists by content id only, and its listing
   * carries no ratings, play counts or studios, so those sorts fall back to
   * title. Ties break on id so pages never overlap.
   */
  private sortItems(
    items: MediaItem[],
    sort?: LibraryQueryOptions['sort'],
    sortOrder?: LibraryQueryOptions['sortOrder'],
  ): MediaItem[] {
    const byTitle = (a: MediaItem, b: MediaItem) =>
      a.title.localeCompare(b.title, undefined, {
        sensitivity: 'base',
        numeric: true,
      });
    const primary = (a: MediaItem, b: MediaItem): number => {
      switch (sort) {
        case 'addedAt':
          return a.addedAt.getTime() - b.addedAt.getTime();
        case 'airDate':
          return (a.year ?? 0) - (b.year ?? 0);
        default:
          return byTitle(a, b);
      }
    };
    const direction = sortOrder === 'desc' ? -1 : 1;

    return [...items].sort(
      (a, b) =>
        direction * primary(a, b) ||
        byTitle(a, b) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }
}
