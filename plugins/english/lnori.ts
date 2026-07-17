import { fetchApi } from '@libs/fetch';
import { storage } from '@libs/storage';
import { Plugin } from '@/types/plugin';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { load as parseHTML } from 'cheerio';
import { defaultCover } from '@libs/defaultCover';

class LnorisPlugin implements Plugin.PluginBase {
  id = 'lnori';
  name = 'LNORI';
  icon = 'src/en/lnori/icon.png';
  site = 'https://lnori.com/';
  version = '1.1.0';
  webStorageUtilized = true;

  private async fetchPage(url: string): Promise<string> {
    const cached = storage.get<string>(url);
    if (cached) return cached;
    const body = await (await fetchApi(url)).text();
    // cache for 30 minutes
    storage.set(url, body, 30 * 60 * 1000);
    return body;
  }

  private extractAppData(html: string): Record<string, unknown> | null {
    const match = html.match(
      /<script[^>]*id="app-data"[^>]*>([\s\S]*?)<\/script>/,
    );
    if (!match?.[1]) return null;
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }

  /**
   * Run async tasks with concurrency limit. Avoids flooding mobile network
   * with 30+ parallel requests that compete for bandwidth.
   */
  private async asyncPool<T, R>(
    items: T[],
    processor: (item: T) => Promise<R>,
    limit = 5,
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (nextIndex < items.length) {
        const idx = nextIndex++;
        results[idx] = await processor(items[idx]);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, () => worker()),
    );
    return results;
  }

  private async getLibraryNovels(): Promise<
    {
      novel: Plugin.NovelItem;
      author: string;
      tags: string[];
    }[]
  > {
    const url = this.site + 'library';
    const body = await this.fetchPage(url);
    const $ = parseHTML(body);

    const parsedList: {
      novel: Plugin.NovelItem;
      author: string;
      tags: string[];
    }[] = [];

    $('article.card').each((i, el) => {
      const name = $(el).attr('data-t') || '';
      const author = $(el).attr('data-a') || '';
      const tagsAttr = $(el).attr('data-tags') || '';
      const tags = tagsAttr.split(',').map(t => t.trim().toLowerCase());

      const coverImg = $(el).find('.card-cover img').first();
      let cover = coverImg.attr('src') || '';
      if (cover && cover.startsWith('/')) {
        cover = this.site + cover.substring(1);
      }

      const link = $(el).find('a.stretched-link').first();
      let path = link.attr('href') || '';
      if (path.startsWith('/')) {
        path = path.substring(1);
      }

      if (path && name) {
        parsedList.push({
          novel: {
            name,
            path,
            cover: cover || defaultCover,
          },
          author,
          tags,
        });
      }
    });

    return parsedList;
  }

  async popularNovels(
    pageNo: number,
    { filters }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const parsedList = await this.getLibraryNovels();

    let filteredList = parsedList;
    const selectedGenre = filters?.genre?.value;
    if (selectedGenre) {
      filteredList = filteredList.filter(item =>
        item.tags.includes(selectedGenre.toLowerCase()),
      );
    }

    const selectedSort = filters?.sort?.value;
    if (selectedSort === 'title-az') {
      filteredList.sort((a, b) => a.novel.name.localeCompare(b.novel.name));
    } else if (selectedSort === 'title-za') {
      filteredList.sort((a, b) => b.novel.name.localeCompare(a.novel.name));
    }

    const pageSize = 36;
    const offset = (pageNo - 1) * pageSize;
    return filteredList
      .slice(offset, offset + pageSize)
      .map(item => item.novel);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const body = await this.fetchPage(this.site + novelPath);

    const loadedCheerio = parseHTML(body);

    const novelInfo = loadedCheerio(
      'script[type="application/ld+json"]',
    ).text();

    let parsed: {
      name?: string;
      image?: string;
      description?: string;
      author?: { name?: string } | { name?: string }[];
      genre?: string;
      hasPart?: { url?: string; name?: string }[];
    } = {};
    try {
      parsed = JSON.parse(novelInfo);
    } catch {
      // JSON-LD missing or malformed — fields will fall back to defaults
    }

    const name =
      parsed.name || loadedCheerio('.hero-card h1.s-title').text().trim();
    const src = loadedCheerio('.hero-card img').attr('src');
    const cover = src
      ? src.startsWith('/')
        ? this.site + src.slice(1)
        : src
      : defaultCover;
    const summary =
      parsed.description ||
      loadedCheerio('section.desc-box p.description')
        .map((_, el) => loadedCheerio(el).text().trim())
        .get()
        .filter(Boolean)
        .join('\n\n');
    let author = [parsed.author]
      .flat()
      .map(a => a?.name)
      .filter(Boolean)
      .join(', ');
    if (!author) {
      author = loadedCheerio('.hero-card p.author').text().trim();
    }

    const genres =
      parsed.genre ||
      loadedCheerio('ul.tags-track a')
        .map((_, el) => loadedCheerio(el).text().trim())
        .get()
        .filter(Boolean)
        .join(',');

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: name || 'Untitled',
      cover,
      summary,
      author,
      genres,
      chapters: [],
    };

    // try JSON-LD first
    const volumeMap: Record<string, string> = {};
    if (parsed.hasPart && Array.isArray(parsed.hasPart)) {
      for (const part of parsed.hasPart) {
        if (part?.url) {
          const volPath = part.url.startsWith(this.site)
            ? part.url.slice(this.site.length)
            : part.url;
          volumeMap[volPath] = part.name || '';
        }
      }
    }

    // Fallback to HTML link scraping
    if (Object.keys(volumeMap).length === 0) {
      loadedCheerio('section.vol-grid article').each((i, el) => {
        const $el = loadedCheerio(el);
        const href = $el.find('a.stretched-link').attr('href');
        const title = $el.find('.card-title span').text().trim();
        const subtitle = $el.find('.card-meta span').text().trim();
        if (href && title) {
          volumeMap[href.startsWith('/') ? href.slice(1) : href] = subtitle
            ? `${title}: ${subtitle}`
            : title;
        }
      });
    }

    const getVolumeName = (_href: string, text: string) => {
      const match = text.match(/(Vol(?:ume)?\.?\s*\d+(?:[-.\s]\d+)?)/i);
      return match ? match[1] : text;
    };

    const volumeUrls = Object.keys(volumeMap);

    // Process volumes with concurrency limit (5)
    const chapters2D = await this.asyncPool(
      volumeUrls,
      async volUrl => {
        const fullVolUrl = this.site + volUrl;
        const volHtml = await this.fetchPage(fullVolUrl);
        const volTitle = getVolumeName(volUrl, volumeMap[volUrl]);
        const volChapters: Plugin.ChapterItem[] = [];

        const appData = this.extractAppData(volHtml);
        if (appData?.hasPart && Array.isArray(appData.hasPart)) {
          for (const part of appData.hasPart) {
            const p = part as Record<string, unknown>;
            if (p?.url && typeof p.url === 'string') {
              const name =
                typeof p.name === 'string'
                  ? p.name.trim().replace(/\s+/g, ' ')
                  : '';
              volChapters.push({
                name: name ? `${volTitle} - ${name}` : volTitle,
                path: volUrl + p.url,
              });
            }
          }
          return volChapters;
        }

        // fallback to cheerio
        const $vol = parseHTML(volHtml);
        $vol('#toc-list a').each((i, el) => {
          const href = $vol(el).attr('href');
          if (!href) return;
          const name =
            $vol(el).attr('title') ||
            $vol(el).text().trim().replace(/\s+/g, ' ');
          volChapters.push({
            name: `${volTitle} - ${name}`,
            path: volUrl + href,
          });
        });
        return volChapters;
      },
      5,
    );
    const chapters = chapters2D.flat();

    novel.chapters = chapters.map((chap, idx) => ({
      ...chap,
      chapterNumber: idx + 1,
    }));

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const [base, anchor] = chapterPath.split('#');
    const $ = parseHTML(await this.fetchPage(this.site + base));

    $('.chapter-title').remove();
    const nextId = $(`#toc-list a[href="#${anchor}"]`)
      .parent()
      .next()
      .find('a')
      .attr('href')
      ?.slice(1);
    const allSections = $('section[id*=page]');
    const start = allSections.index($(`section#${anchor}`));
    if (start === -1) return '';

    const end = nextId ? allSections.index($(`section#${nextId}`)) : -1;

    return allSections
      .slice(start, end !== -1 ? end : allSections.length)
      .map((_, el) => $(el).html() || '')
      .get()
      .join('<hr>');
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const parsedList = await this.getLibraryNovels();

    const term = searchTerm.toLowerCase();
    const filteredList = parsedList.filter(item => {
      return (
        item.novel.name.toLowerCase().includes(term) ||
        item.author.toLowerCase().includes(term) ||
        item.tags.some(t => t.includes(term))
      );
    });

    const pageSize = 36;
    const offset = (pageNo - 1) * pageSize;
    return filteredList
      .slice(offset, offset + pageSize)
      .map(item => item.novel);
  }

  // resolveUrl = (path: string, _isNovel?: boolean) => {
  //   return new URL(path, this.site).href;
  // };

  filters = {
    sort: {
      label: 'Sort By',
      value: 'popular',
      options: [
        { label: 'Popular (Default)', value: 'popular' },
        { label: 'Title A-Z', value: 'title-az' },
        { label: 'Title Z-A', value: 'title-za' },
      ],
      type: FilterTypes.Picker,
    },
    genre: {
      label: 'Genre',
      value: '',
      options: [
        { label: 'All', value: '' },
        { label: 'Academy', value: 'academy' },
        { label: 'Action', value: 'action' },
        { label: 'Adventure', value: 'adventure' },
        { label: 'Comedy', value: 'comedy' },
        { label: 'Drama', value: 'drama' },
        { label: 'Fantasy', value: 'fantasy' },
        { label: 'Harem', value: 'harem' },
        { label: 'Historical', value: 'historical' },
        { label: 'Isekai', value: 'isekai' },
        { label: 'Magic', value: 'magic' },
        { label: 'Mystery', value: 'mystery' },
        { label: 'Psychological', value: 'psychological' },
        { label: 'Reincarnation', value: 'reincarnation' },
        { label: 'Romance', value: 'romance' },
        { label: 'Sci-Fi', value: 'sci-fi' },
        { label: 'Slice of Life', value: 'slice-of-life' },
        { label: 'Tragedy', value: 'tragedy' },
        { label: 'Female Protagonist', value: 'female protagonist' },
        { label: 'Male Protagonist', value: 'male protagonist' },
      ],
      type: FilterTypes.Picker,
    },
  } satisfies Filters;
}

export default new LnorisPlugin();
