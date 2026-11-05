import { SiloMapper } from './silo.mapper';
import type { SiloAdminCatalogItem, SiloCatalogItemDetail } from './silo.types';

describe('SiloMapper', () => {
  it.each([
    ['movie', 'movie'],
    ['series', 'show'],
    ['season', 'season'],
    ['episode', 'episode'],
    ['audiobook', undefined],
    ['manga', undefined],
  ])('maps item kind %s to %s', (kind, expected) => {
    expect(SiloMapper.toMediaItemType(kind)).toBe(expected);
  });

  it.each([
    ['movies', 'movie'],
    ['series', 'show'],
    ['mixed', undefined],
    ['podcasts', undefined],
  ])('maps library kind %s to %s', (kind, expected) => {
    expect(SiloMapper.toLibraryType(kind)).toBe(expected);
  });

  it('takes a catalog row provider ids, sizes and bitrate in bps', () => {
    const row: SiloAdminCatalogItem = {
      content_id: 'movie-1',
      type: 'movie',
      title: 'Sample Movie',
      added_at: '2026-01-01T00:00:00Z',
      library_ids: ['1'],
      imdb_id: 'tt0000001',
      tmdb_id: '101',
      versions: [
        {
          file_id: 'f1',
          library_id: '1',
          file_size: 1000,
          bitrate_kbps: 2000,
        },
      ],
    };

    expect(SiloMapper.fromCatalogRow(row)).toMatchObject({
      providerIds: { imdb: ['tt0000001'], tmdb: ['101'], tvdb: [] },
      mediaSources: [{ sizeBytes: 1000, bitrate: 2_000_000 }],
      library: { id: '1' },
      addedAt: new Date('2026-01-01T00:00:00Z'),
    });
  });

  it('dates a season detail by its series row and parents it to the series', () => {
    const detail = {
      content_id: 'season-1',
      type: 'season',
      title: 'Season 1',
      series_id: 'series-1',
      season_number: 1,
      genres: [],
      cast: [],
      ratings: [{ source: 'tmdb', name: 'TMDB', score: 75 }],
      versions: [],
    } as SiloCatalogItemDetail;
    const seriesRow = {
      content_id: 'series-1',
      type: 'series',
      title: 'Sample Series',
      added_at: '2026-02-01T00:00:00Z',
      library_ids: ['2'],
      versions: [],
    } as SiloAdminCatalogItem;

    expect(SiloMapper.fromDetail(detail, seriesRow)).toMatchObject({
      type: 'season',
      parentId: 'series-1',
      addedAt: new Date('2026-02-01T00:00:00Z'),
      library: { id: '2' },
      index: 1,
      ratings: [{ source: 'tmdb', value: 7.5, type: 'audience' }],
    });
  });
});
