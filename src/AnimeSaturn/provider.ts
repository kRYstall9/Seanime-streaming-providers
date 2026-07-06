/// <reference path='./onlinestream-provider.d.ts' />
/// <reference path='./core.d.ts' />

class Provider {
  private apiUrl = "https://www.animesaturn.net";
  private threshold = 0.7;
  private itaRegex = /\(\s*ITA\s*\)/i;

  getSettings(): Settings {
    return {
      episodeServers: ["Server 1"],
      supportsDub: true,
    };
  }

  async search(query: SearchOptions): Promise<SearchResult[]> {
    let normalizedQuery = normalizeQuery(query.query);
    console.debug("Normalized query:", normalizedQuery);
    console.debug(query);
    const aniListTitlesAndSynonyms: string[] = [];

    if (query.media != null) {
      if (query.media.synonyms != null) {
        aniListTitlesAndSynonyms.push(...query.media.synonyms);
      }

      if (query?.media?.englishTitle != null) {
        aniListTitlesAndSynonyms.push(query.media.englishTitle);
      }

      if (query?.media?.romajiTitle != null) {
        aniListTitlesAndSynonyms.push(query.media.romajiTitle);
      }
    }

    aniListTitlesAndSynonyms.push(query.query);

    const result = await this.scrapeMainDomain(
      normalizedQuery,
      query.dub,
      aniListTitlesAndSynonyms,
      query.media.id == 0,
    );

    if (result) return result;

    throw new Error("No results found");
  }

  async findEpisodes(id: string): Promise<EpisodeDetails[]> {
    const url = new URL(`${this.apiUrl}/${id}`);

    const html = await _makeRequest(url.toString(), this.apiUrl);

    const $ = LoadDoc(html);

    const episodes: EpisodeDetails[] = [];

    $(".ep-tile").each((_, element) => {
      const url = element.attr("href") || "";
      const title = element.attr("title")?.trim() || "";
      const number: number = parseInt(url.split("/ep-")[1]);
      const id = url;

      episodes.push({
        id: id,
        number: number,
        url: `${this.apiUrl}${url.replace("episode", "anime")}`,
        title: title,
      });
    });

    return episodes;
  }

  async findEpisodeServer(
    episode: EpisodeDetails,
    _server: string,
  ): Promise<EpisodeServer> {
    let server = "Server 1";
    if (_server !== "default") server = _server;

    console.log(`Episode URL: ${episode.url}`);

    let html = await _makeRequest(episode.url, this.apiUrl, false);

    const $ = LoadDoc(html);
    const episodeServerUrl = $("#watch-iframe").attr("src") || "";

    html = await _makeRequest(episodeServerUrl, this.apiUrl, false);

    const match = html.match(/window\.__E\s*=\s*(\{[\s\S]*?\})\s*;/);
    let data: { i: Number; k: string; e: Number } = { i: 0, k: "0", e: 0 };

    if (match.length > 1) {
      data = Function("return " + match[1])();
    }

    console.log("Episode Server Url: " + episodeServerUrl);
    console.log("DATA", data.e, data.i, data.k);

    let episodeServerUrlparts = episodeServerUrl.split("?token");
    let url = `${episodeServerUrlparts[0]}/playlist?token${episodeServerUrlparts[1]}`;

    console.debug("Final URL: ", url);
    console.debug("URL PARTS: ", episodeServerUrlparts);

    const host = episodeServerUrlparts[0]
      .split("https://")[1]
      .split("/embed")[0];

    let json = await _makeRequest(url, episodeServerUrl, true);

    console.log("HOST", host);

    json = JSON.parse(json);
    console.debug("Parsed json: ", json);

    const finalEpisodeUrl = this.decodeUrl(json.d, data.k);

    console.debug(finalEpisodeUrl);

    const type: VideoSourceType = finalEpisodeUrl.includes(".mp4")
      ? "mp4"
      : finalEpisodeUrl.includes(".m3u8")
        ? "m3u8"
        : "unknown";

    return {
      headers: {
        Referer: "https://" + host,
        Origin: "https://" + host,
      },
      server: _server,
      videoSources: [
        {
          quality: "unknown",
          subtitles: [],
          type: type,
          url: finalEpisodeUrl,
        },
      ],
    };
  }

  async getPlaylistToken(url: string) {
    const urlParts: string[] = url.split("?token");

    url = `${urlParts[0]}/playlist${urlParts[1]}`;
    const response = await _makeRequest(url, this.apiUrl);

    console.log(`${this.getPlaylistToken.name}: ` + response);
  }

  async scrapeMainDomain(
    query: string,
    isDub: boolean,
    aniListTitlesAndSynonyms: string[],
    isManualSearch: boolean = false,
  ) {
    let url = `${this.apiUrl}/filter?key=${encodeURIComponent(query)}`;
    let html = await _makeRequest(url, this.apiUrl);
    let normalizedQuery: string = "";

    if (html.includes("Nessun anime trovato")) {
      normalizedQuery = addSeasonWordToQuery(query);

      if (normalizedQuery === "") {
        throw new Error(
          "Error encountered while adding Season word to query: " + query,
        );
      }
      url = `${this.apiUrl}/filter?key=${encodeURIComponent(normalizedQuery)}`;
      html = await _makeRequest(url, this.apiUrl);
    }

    if (html.includes("Nessun anime trovato")) {
      throw new Error("No results found for the query: " + normalizedQuery);
    }

    const results: SearchResult[] = [];
    const validTitles: { title: string; score: number }[] = [];
    const totalPages: number | null = getPageNumbers(html);

    if (totalPages == null) {
      throw new Error("No anime found");
    }

    for (let i = 1; i <= totalPages; i++) {
      if (i > 1) {
        url = `${this.apiUrl}/filter/${i}?key=${normalizedQuery}`;
        try {
          html = await _makeRequest(url, this.apiUrl);
        } catch (error) {
          console.error(error);
        }
      }

      let $ = LoadDoc(html);

      $(".rail>a").each((_, element) => {
        const url = element.attr("href") || "";
        const title = element.find("h3.ac__title").text().trim();
        const id = url;
        let subOrDub: SubOrDub = "sub";

        let titleToCompareDub: string = "";

        const dubBadge: DocSelection | null = element.find(".ac__dub-badge");

        if (isDub && (!this.itaRegex.test(title) || dubBadge.text() == ""))
          return;

        if (!isDub && dubBadge.text() != "") return;

        if (isDub) {
          titleToCompareDub = title.replace(/\s*\(\s*ita\s*\)\s*/gi, "").trim();
          subOrDub = "dub";
        }

        try {
          let titleToSubmit: string = isDub ? titleToCompareDub : title;
          let bestScore: number | null = filterBySimilarity(
            titleToSubmit,
            aniListTitlesAndSynonyms,
            this.threshold,
          );
          console.debug(title, bestScore);
          if (bestScore != null) {
            validTitles.push({ title: title, score: bestScore });
          }
          console.debug(validTitles);
        } catch (error) {
          console.error("Error: " + error);
        }

        results.push({
          id: id,
          title: title,
          url: `${this.apiUrl}${url}`,
          subOrDub: subOrDub,
        });
      });
    }
    c;

    console.debug("Valid titles:", validTitles);

    if (validTitles.length > 0) {
      let bestMatch = validTitles.reduce((prev, current) =>
        prev.score > current.score ? prev : current,
      );
      console.debug("BEST MATCH: ", bestMatch);
      let animeToReturn = results
        .filter((anime) => anime.subOrDub == (isDub ? "dub" : "sub"))
        .filter(
          (anime) =>
            anime.title.toLowerCase() === bestMatch.title.toLowerCase(),
        )[0];

      if (animeToReturn) return [animeToReturn];
    }

    throw new Error("No results found");
  }

  decodeUrl(encoded: string, key: string) {
    try {
      console.debug("ENCODED:", encoded);
      console.debug("KEY:", key);

      if (!encoded || !key) {
        throw new Error("Missing encoded or key");
      }

      const bytes: Uint8Array = CryptoJS.enc.Base64.parse(encoded);

      let out = "";

      for (let i = 0; i < bytes.length; i++) {
        out += String.fromCharCode(bytes[i] ^ key.charCodeAt(i % key.length));
      }

      console.debug("OUT:", out);
      return out;
    } catch (err) {
      console.error("decodeUrl failed:", err);
      return "";
    }
  }
}

function normalizeQuery(query: string): string {
  const extras = [
    "EXTRA PART",
    "OVA",
    "SPECIAL",
    "RECAP",
    "FINAL SEASON",
    "BONUS",
    "SIDE STORY",
    "PART\\s*\\d+",
    "EPISODE\\s*\\d+",
  ];

  const pattern = new RegExp(`\\b(${extras.join("|")})\\b`, "gi");

  let normalizedQuery: string = query
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, "$1") //Removes suffixes from a number I.e. 3rd, 1st, 11th, 12th, 2nd -> 3, 1, 11, 12, 2
    .replace(/(\d+)\s*Season/i, "$1") //Removes season and keeps the number before the Season word
    .replace(/Season\s*(\d+)/i, "$1") //Removes season and keeps the number after the Season word
    .replace(pattern, "") //Removes extras
    .replace(/-.*?-/g, "") // Removes -...-
    .replace(/\bThe(?=\s+Movie\b)/gi, "")
    .replace(/~/g, " ") //Removes ~
    .replace(/\s+/g, " ") //Replaces 1+ whitespaces with 1
    .trim();

  const match = normalizedQuery.match(/[^a-zA-Z0-9 ]/);

  if (match) {
    const index = match.index!;
    return normalizedQuery.slice(0, index).trim();
  }

  return normalizedQuery;
}

/**
 * Extracts the total number of pages from the provided HTML string.
 * Useful for paginated results (e.g., a search query that returns many results).
 *
 * @param html
 * @returns
 */

function getPageNumbers(
  html: string,
  isMainDomain: boolean = true,
): number | null {
  if (html == null || html == "") {
    return null;
  }

  const $ = LoadDoc(html);
  let totalPages = 1;

  $(".page-num").each((_, el: DocSelection) => {
    try {
      let num = Number(el.text());
      if (num != 0) {
        totalPages = num;
      }
    } catch (err) {
      console.error(`An error occured while parsing ${el.text()} to Number`);
    }
  });

  console.debug(`Total pages: ${totalPages}`);
  return totalPages;
}

function addSeasonWordToQuery(query: string): string {
  if (/Season/i.test(query)) return query;

  const match = query.match(/\b(\d+)(st|nd|rd|th)?\b/);
  if (!match || match.index === undefined) return query;
  return "";
}

/**
 * Returns the HTML body of an HTTP response
 *
 * @param url -> The URL to fetch
 * @returns  A string with the response body, or a fallback message if any error occurs
 */

async function _makeRequest(
  url: string,
  referer: string,
  returnJson: boolean = false,
  headers = {},
): Promise<any> {
  const userAgent =
    "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0";
  let response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      Referer: referer,
      "User-Agent": userAgent,
    },
  });

  let bodyText = await response.text();

  const match = bodyText.match(/document\.cookie="([^"]+)"/);

  if (match) {
    const cookie = match[1].split(";")[0];

    response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": returnJson ? "application/json" : "text/html",
        Referer: referer,
        "User-Agent": userAgent,
        Cookie: cookie,
        ...headers,
      },
    });

    return returnJson ? await response.json() : await response.text();
  }

  return bodyText;
}

/**
 *
 * Returns the number of single-character edits required to change one word into another
 *
 * @param a -> String to compare
 * @param b -> String to be compared with
 * @returns
 */

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  // Inizializza la prima colonna e riga della matrice
  for (let i = 0; i <= a.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= b.length; j++) {
    matrix[0][j] = j;
  }

  // Calcola la distanza
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;

      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1, // Cancellazione
        matrix[i][j - 1] + 1, // Inserimento
        matrix[i - 1][j - 1] + cost, // Sostituzione
      );
    }
  }

  return matrix[a.length][b.length];
}

/**
 *
 * Returns the score based on the levenshtein distance algorithm
 *
 * @param a -> String to compare
 * @param b -> String to be compared with
 * @returns
 */

function similarityScore(a: string, b: string): number {
  const distance = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);

  console.debug("DISTANCE: " + distance);
  console.debug("MAXLEN: " + maxLen);
  console.debug(1 - distance / maxLen);

  if (maxLen === 0) return 1; // Evita divisione per zero
  return 1 - distance / maxLen;
}

/**
 *
 * Returns the highest score based on the levenshtein distance algorithm
 *
 * @param input -> String to compare
 * @param candidates -> String[] to compare the input with
 * @param threshold
 * @returns
 */

function filterBySimilarity(
  input: string,
  candidates: string[],
  threshold: number,
): number | null {
  if (!input || input.trim() === "") {
    console.error("Invalid input string.");
    return null;
  }

  let validMatches = candidates
    .map((candidate) => ({
      title: candidate,
      score: similarityScore(
        normalizeStringBeforeLevenshtein(input),
        normalizeStringBeforeLevenshtein(candidate),
      ),
    }))
    .filter((item) => item.score >= threshold);

  if (validMatches.length > 0) {
    return validMatches.reduce((prev, current) =>
      prev.score > current.score ? prev : current,
    ).score;
  }

  return null;
}

/**
 * Replaces Season with empty string.
 * Keeps the number and not the suffix -> [2nd] = [2]
 * Replaces any number of sequential whitespace with just one
 * Converts the string to lower case
 *
 * @param input
 * @returns
 */

function normalizeStringBeforeLevenshtein(input: string): string {
  const normalized = input
    .replace(/Season/gi, "")
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return normalized;
}
