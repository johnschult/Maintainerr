import { AxiosError, type AxiosRequestConfig } from 'axios';
import { SiloAdapterService } from './silo-adapter.service';
import type {
  SiloAdminCatalogItem,
  SiloCatalogItemDetail,
  SiloSeason,
} from './silo.types';

jest.mock('../../lib/cache', () => ({
  __esModule: true,
  default: {
    getCache: jest.fn().mockImplementation(() => ({
      flush: jest.fn(),
      data: {
        get: jest.fn(),
        set: jest.fn(),
        has: jest.fn(),
        del: jest.fn(),
      },
    })),
  },
}));

type Route = (config?: AxiosRequestConfig) => unknown;

const responseError = (status: number): AxiosError => {
  const error = new AxiosError(`request failed with status ${status}`);
  Object.assign(error, {
    response: { status, data: {}, headers: {}, config: {} },
  });
  return error;
};

const movieRow = (id: string, title: string, addedAt: string) =>
  ({
    content_id: id,
    type: 'movie',
    title,
    added_at: addedAt,
    library_ids: ['1'],
    versions: [],
  }) as SiloAdminCatalogItem;

const seriesRow = {
  content_id: 'series-1',
  type: 'series',
  title: 'Sample Series',
  added_at: '2026-01-01T00:00:00Z',
  library_ids: ['2'],
  versions: [],
} as SiloAdminCatalogItem;

const episodeRow = (episode: number) =>
  ({
    content_id: `episode-1-${episode}`,
    type: 'episode',
    title: `Episode ${episode}`,
    added_at: '2026-01-02T00:00:00Z',
    library_ids: ['2'],
    versions: [],
    series_id: 'series-1',
    series_title: 'Sample Series',
    season_number: 1,
    episode_number: episode,
  }) as SiloAdminCatalogItem;

const season1: SiloSeason = {
  content_id: 'season-1-1',
  season_number: 1,
  title: 'Season 1',
  episode_count: 2,
};

describe('SiloAdapterService', () => {
  let service: SiloAdapterService;
  let routes: Map<string, Route>;
  let http: { get: jest.Mock };

  /** Answer the admin catalog from a fixed set of rows, by id or as pages. */
  const catalog = (rows: SiloAdminCatalogItem[]): Route => {
    return (config) => {
      const ids = config?.params?.content_ids as string[] | undefined;
      return {
        items: ids ? rows.filter((row) => ids.includes(row.content_id)) : rows,
        page: { has_more: false },
      };
    };
  };

  beforeEach(() => {
    routes = new Map();
    http = {
      get: jest.fn(async (path: string, config?: AxiosRequestConfig) => {
        const route = routes.get(path);
        if (!route) throw new Error(`unexpected GET ${path}`);
        const result = route(config);
        if (result instanceof Error) throw result;
        return { data: result };
      }),
    };

    service = new SiloAdapterService(
      { silo_url: 'http://silo.test', silo_api_key: 'key' } as any,
      {
        setContext: jest.fn(),
        debug: jest.fn(),
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      } as any,
    );
    Object.assign(service, {
      http,
      initialized: true,
      profileId: 'profile-1',
    });
    routes.set('/libraries', () => ({
      items: [
        { id: '1', name: 'Movies', type: 'movies', enabled: true },
        { id: '2', name: 'Series', type: 'series', enabled: true },
      ],
    }));
    routes.set('/catalog/series/series-1/seasons', () => ({
      items: [season1],
    }));
  });

  describe('getLibraryContents', () => {
    it('walks every cursor page, so offset pages and totalSize cover the whole library', async () => {
      routes.set('/admin/catalog/items', (config) =>
        config?.params?.cursor === 'next'
          ? {
              items: [movieRow('m3', 'Movie C', '2026-01-03T00:00:00Z')],
              page: { has_more: false },
            }
          : {
              items: [
                movieRow('m1', 'Movie A', '2026-01-01T00:00:00Z'),
                movieRow('m2', 'Movie B', '2026-01-02T00:00:00Z'),
              ],
              page: { has_more: true, next_cursor: 'next' },
            },
      );

      const page = await service.getLibraryContents('1', {
        offset: 1,
        limit: 1,
        sort: 'addedAt',
        sortOrder: 'desc',
      });

      expect(page.totalSize).toBe(3);
      expect(page.items.map((item) => item.id)).toEqual(['m2']);
    });

    it.each([
      [
        'a failed page read',
        () => responseError(502),
        'request failed with status 502',
      ],
      [
        'a cursor that does not advance',
        () => ({ items: [], page: { has_more: true, next_cursor: undefined } }),
        'made no progress',
      ],
    ])(
      'throws on %s rather than answering a short library',
      async (_case, route, message) => {
        routes.set('/admin/catalog/items', route);

        await expect(
          service.getLibraryContents('1', { offset: 0, limit: 50 }),
        ).rejects.toThrow(message);
      },
    );

    it('gives episodes their season and series as parent and grandparent', async () => {
      routes.set('/admin/catalog/items', catalog([episodeRow(1)]));

      const { items } = await service.getLibraryContents('2', {
        type: 'episode',
      });

      expect(items[0]).toMatchObject({
        parentId: 'season-1-1',
        grandparentId: 'series-1',
        index: 1,
        parentIndex: 1,
      });
    });
  });

  describe('itemExists', () => {
    it('reports an item gone only when Silo answers 404', async () => {
      routes.set('/catalog/items/gone', () => responseError(404));

      await expect(service.itemExists('gone')).resolves.toBe(false);
    });

    it('throws on any other failure, so a blip never reads as deleted', async () => {
      routes.set('/catalog/items/movie-1', () => responseError(503));

      await expect(service.itemExists('movie-1')).rejects.toBeInstanceOf(
        AxiosError,
      );
    });
  });

  describe('getChildrenMetadata', () => {
    it('fails a season read when the catalog misses one of its episodes', async () => {
      routes.set('/catalog/items/season-1-1/episodes', () => ({
        items: [
          { content_id: 'episode-1-1', season_number: 1, episode_number: 1 },
          { content_id: 'episode-1-2', season_number: 1, episode_number: 2 },
        ],
      }));
      routes.set('/catalog/items/season-1-1', () => ({
        content_id: 'season-1-1',
        type: 'season',
        title: 'Season 1',
        series_id: 'series-1',
        genres: [],
        cast: [],
        ratings: [],
        versions: [],
      }));
      routes.set('/admin/catalog/items', catalog([seriesRow, episodeRow(1)]));

      await expect(
        service.getChildrenMetadata('season-1-1', 'episode', true),
      ).rejects.toThrow('Could not read the children of Silo item season-1-1');
    });
  });

  describe('getMetadataBatch', () => {
    it('reads ids the admin catalog does not list, such as seasons, one by one', async () => {
      routes.set('/admin/catalog/items', catalog([seriesRow]));
      routes.set(
        '/catalog/items/season-1-1',
        () =>
          ({
            content_id: 'season-1-1',
            type: 'season',
            title: 'Season 1',
            series_id: 'series-1',
            season_number: 1,
            genres: [],
            cast: [],
            ratings: [],
            versions: [],
          }) as SiloCatalogItemDetail,
      );

      const items = await service.getMetadataBatch(['series-1', 'season-1-1']);

      expect(items.map((item) => [item.id, item.type])).toEqual([
        ['series-1', 'show'],
        ['season-1-1', 'season'],
      ]);
    });
  });

  it.each([
    ['getWatchHistory', () => service.getWatchHistory('movie-1')],
    ['getActiveSessions', () => service.getActiveSessions()],
    ['getCollectionChildren', () => service.getCollectionChildren('c1')],
  ])(
    '%s throws until implemented instead of answering empty',
    async (_name, call) => {
      await expect(call()).rejects.toThrow('not implemented yet');
    },
  );
});
