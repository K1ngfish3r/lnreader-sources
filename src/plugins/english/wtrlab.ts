import { Plugin } from '@typings/plugin';
import { fetchApi } from '@libs/fetch';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { load as parseHTML } from 'cheerio';

type Raw = {
  title: string;
  author: string;
  description: string;
};

type Data = {
  title: string;
  author: string;
  description: string;
  image: string;
  from_user?: string;
  raw?: Raw;
};

// Used in parseNovel (nested within Serie) and as items in popular/trending/random lists
type SerieData = {
  recommendation_id?: number;
  score?: string;
  id: number;
  slug: string;
  search_text: string;
  status: number;
  data: Data;
  created_at: string;
  updated_at: string;
  view: number;
  in_library: number;
  rating: number | null;
  chapter_count: number;
  power: number;
  total_rate: number;
  user_status: number;
  verified: boolean;
  from: string | null;
  raw_id: number;
  genres?: number[];
  ai_enabled?: boolean; // Optional based on JSON
  released_by?: string | null; // Optional based on JSON
  raw_created_at?: string; // Optional based on JSON
  view_count?: string; // Optional based on JSON (daily)
  serie_id?: number; // Optional based on JSON (random)
};

// Used in parseNovel (nested within Serie) and RecentNovelItem
type Chapter = {
  id: number;
  order: number;
  slug: string;
  title: string;
  name?: string; // Optional based on JSON
  created_at: string;
  updated_at: string;
  code?: string; // Optional based on JSON
  serie_id?: number; // Optional based on JSON
};

// Used in parseNovel (nested within PageProps)
type ChapterData = {
  data: ChapterContent;
};

// Used in parseNovel (nested within ChapterData)
type ChapterContent = {
  title: string;
  body: string;
};

// Used in parseNovel and RecentNovelItem
type Serie = {
  id: number;
  raw_id: number;
  slug: string;
  data: Data;
  is_default?: boolean; // Optional based on JSON
  raw_type?: string; // Optional based on JSON
  serie_data: SerieData; // Used in parseNovel - Made required
  chapters: Chapter[]; // Used in parseNovel and RecentNovelItem - Made required
  recommendation?: SerieData[]; // Used in parseNovel
  chapter_data: ChapterData; // Used in parseNovel - Made required
};

// Used in parseNovel
type PageProps = {
  series?: SerieData[]; // Optional based on JSON (popular/trending/random)
  serie: Serie; // Used in parseNovel - Made required
  server_time: Date;
  daily?: SerieData[]; // Optional based on JSON
  recently?: RecentNovelItem[]; // Optional based on JSON
  random?: SerieData[]; // Optional based on JSON
  trending?: SerieData[]; // Optional based on JSON
  beta_recommendation?: SerieData[]; // Optional based on JSON
  r_index?: number; // Optional based on JSON
  _sentryTraceData?: string; // Optional based on JSON
  _sentryBaggage?: string; // Optional based on JSON
};

// Used in parseNovel
type Props = {
  pageProps: PageProps;
  __N_SSP: boolean;
};

// Used in parseNovel
type NovelJson = {
  props: Props;
  page: string;
  query?: {}; // Optional based on JSON
  buildId?: string; // Optional based on JSON
  isFallback?: boolean; // Optional based on JSON
  isExperimentalCompile?: boolean; // Optional based on JSON
  gssp?: boolean; // Optional based on JSON
  locale?: string; // Optional based on JSON
  locales?: string[]; // Optional based on JSON
  defaultLocale?: string; // Optional based on JSON
  scriptLoader?: any[]; // Optional based on JSON
};

// Used in popularNovels (showLatestNovels: true)
type RecentNovelItem = {
  serie: Serie;
  chapters: Chapter[];
  updated_at: string; // Changed from Date to string based on JSON
};

// Used in popularNovels (showLatestNovels: false) and searchNovels
type JsonNovelList = {
  // Renamed from JsonNovel to avoid conflict
  success: boolean;
  data: SerieData[]; // Changed from Datum[] to SerieData[] based on JSON structure
};

// Used in popularNovels (showLatestNovels: true)
type JsonRecentNovelList = {
  success: boolean;
  data: RecentNovelItem[];
};

class WTRLAB implements Plugin.PluginBase {
  id = 'WTRLAB';
  name = 'WTR-LAB';
  site = 'https://wtr-lab.com/';
  version = '1.0.1';
  icon = 'src/en/wtrlab/icon.png';
  sourceLang = 'en/';

  async popularNovels(
    page: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const params = new URLSearchParams();
    params.append('orderBy', filters.order.value);
    params.append('order', filters.sort.value);
    params.append('filter', filters.storyStatus.value);
    params.append('page', String(page)); //TODO Genre & Advance Searching Filter. Ez to implement, too much manual work, too lazy.

    const link =
      this.site + this.sourceLang + 'novel-list?' + params.toString();

    if (showLatestNovels) {
      const response = await fetchApi(this.site + 'api/home/recent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ page: page }),
      });

      const recentNovel: JsonRecentNovelList = await response.json();

      // Parse novels from JSON
      const novels: Plugin.NovelItem[] = recentNovel.data.map(
        (datum: RecentNovelItem) => ({
          name: datum.serie.data.title || '',
          cover: datum.serie.data.image,
          path: new URL(
            this.sourceLang +
              'serie-' +
              datum.serie.raw_id +
              '/' +
              datum.serie.slug,
            this.site,
          ).pathname.substring(1),
        }),
      );

      return novels;
    } else {
      const body = await fetchApi(link).then(res => res.text());
      const loadedCheerio = parseHTML(body);
      const novels: Plugin.NovelItem[] = loadedCheerio('.serie-item')
        .map((_, element) => ({
          name:
            loadedCheerio(element)
              .find('.title-wrap > a')
              .text()
              .replace(loadedCheerio(element).find('.rawtitle').text(), '') ||
            '',
          cover: loadedCheerio(element).find('img').attr('src'),
          path: new URL(
            loadedCheerio(element).find('a').attr('href') || '',
            this.site,
          ).pathname.substring(1),
        }))
        .get()
        .filter(novel => novel.name && novel.path);
      return novels;
    }
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const body = await fetchApi(this.site + novelPath).then(res => res.text());
    const loadedCheerio = parseHTML(body);

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: loadedCheerio('h1.text-uppercase').text(),
      cover: loadedCheerio('.img-wrap > img').attr('src'),
      summary: loadedCheerio('.lead').text().trim(),
    };

    novel.genres = loadedCheerio('td:contains("Genre")')
      .next()
      .find('a')
      .map((i, el) => loadedCheerio(el).text())
      .toArray()
      .join(',');

    novel.author = loadedCheerio('td:contains("Author")')
      .next()
      .text()
      .replace(/[\t\n]/g, '');

    novel.status = loadedCheerio('td:contains("Status")')
      .next()
      .text()
      .replace(/[\t\n]/g, '');

    const chapterJson = loadedCheerio('#__NEXT_DATA__').prop('innerHtml') + '';
    const jsonData: NovelJson = JSON.parse(chapterJson);

    const chapters: Plugin.ChapterItem[] =
      jsonData.props.pageProps.serie.chapters.map(
        (jsonChapter, chapterIndex) => ({
          name: jsonChapter.title,
          path:
            this.sourceLang +
            'serie-' +
            jsonData.props.pageProps.serie.serie_data.raw_id +
            '/' +
            jsonData.props.pageProps.serie.serie_data.slug +
            '/chapter-' +
            jsonChapter.order, // Assuming 'slug' is the intended path
          releaseTime: (
            jsonChapter?.created_at || jsonChapter?.updated_at
          )?.substring(0, 10),
          chapterNumber: chapterIndex + 1,
        }),
      );

    novel.chapters = chapters;

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const body = await fetchApi(this.site + chapterPath).then(res =>
      res.text(),
    );

    const loadedCheerio = parseHTML(body);
    const chapterJson = loadedCheerio('#__NEXT_DATA__').html() + '';
    const jsonData: NovelJson = JSON.parse(chapterJson);

    const chapterContent = JSON.stringify(
      jsonData.props.pageProps.serie.chapter_data.data.body,
    );
    const parsedArray = JSON.parse(chapterContent);
    let htmlString = '';

    for (const text of parsedArray) {
      htmlString += `<p>${text}</p>`;
    }

    return htmlString;
  }

  async searchNovels(searchTerm: string): Promise<Plugin.NovelItem[]> {
    const response = await fetchApi(this.site + 'api/search', {
      headers: {
        'Content-Type': 'application/json',
        Referer: this.site + this.sourceLang,
        Origin: this.site,
      },
      method: 'POST',
      body: JSON.stringify({ text: searchTerm }),
    });

    const recentNovel: JsonNovelList = await response.json();

    // Parse novels from JSON
    const novels: Plugin.NovelItem[] = recentNovel.data.map(
      (datum: SerieData) => ({
        name: datum.data.title || '',
        cover: datum.data.image,
        path: new URL(
          this.sourceLang + 'serie-' + datum.raw_id + '/' + datum.slug || '',
          this.site,
        ).pathname.substring(1),
      }),
    );

    return novels;
  }

  filters = {
    order: {
      value: 'chapter',
      label: 'Order by',
      options: [
        { label: 'View', value: 'view' },
        { label: 'Name', value: 'name' },
        { label: 'Addition Date', value: 'date' },
        { label: 'Reader', value: 'reader' },
        { label: 'Chapter', value: 'chapter' },
      ],
      type: FilterTypes.Picker,
    },
    sort: {
      value: 'desc',
      label: 'Sort by',
      options: [
        { label: 'Descending', value: 'desc' },
        { label: 'Ascending', value: 'asc' },
      ],
      type: FilterTypes.Picker,
    },
    storyStatus: {
      value: 'all',
      label: 'Status',
      options: [
        { label: 'All', value: 'all' },
        { label: 'Ongoing', value: 'ongoing' },
        { label: 'Completed', value: 'completed' },
      ],
      type: FilterTypes.Picker,
    },
  } satisfies Filters;
}

export default new WTRLAB();
